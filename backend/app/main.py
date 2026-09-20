import asyncio
import os
import time
from contextlib import asynccontextmanager
from datetime import date
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from .intelligence import router as intelligence_router
from .analysis import AOI, router as analysis_router
from .land import router as land_router
from .news import router as news_router
from .analysis_store import recover_interrupted
from .admin_bootstrap import bootstrap_on_startup
from .scientific_tools import router as scientific_router

CDSE_STAC_SEARCH = "https://stac.dataspace.copernicus.eu/v1/search"
CDSE_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CDSE_PROCESS_URL = "https://sh.dataspace.copernicus.eu/process/v1"

allowed_origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if origin.strip()]
token_cache: dict[str, object] = {"access_token": None, "expires_at": 0.0}

@asynccontextmanager
async def lifespan(app):
    recover_interrupted()
    await bootstrap_on_startup()
    yield


app = FastAPI(title="ALETHEOPSIS API", version="0.4.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(intelligence_router)
app.include_router(analysis_router)
app.include_router(land_router)
app.include_router(news_router)
app.include_router(scientific_router)


class AreaOfInterest(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    bbox: list[float] = Field(min_length=4, max_length=4)
    source: Literal["preset", "map"]
    geometry: dict | None = None

    @model_validator(mode="after")
    def validate_bbox(self):
        west, south, east, north = self.bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("bbox must be [west, south, east, north] in WGS84 degrees")
        if self.geometry:
            AOI(name=self.name, bbox=self.bbox, source=self.source, geometry=self.geometry)
        return self


class CatalogSearchRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2_000)
    aoi: AreaOfInterest
    startDate: date
    endDate: date
    sensors: list[Literal["sentinel-2", "sentinel-1"]] = Field(default_factory=lambda: ["sentinel-2"])
    tools: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.startDate > self.endDate:
            raise ValueError("startDate must not be after endDate")
        if (self.endDate - self.startDate).days > 730:
            raise ValueError("date range must be 730 days or less")
        return self


class RenderRequest(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4)
    startDate: date
    endDate: date
    layer: Literal["true-color", "ndvi", "sar"] = "true-color"
    width: int = Field(default=1024, ge=64, le=2048)
    height: int = Field(default=1024, ge=64, le=2048)


def scene_from_feature(feature: dict, collection: str) -> dict:
    properties = feature.get("properties") or {}
    assets = feature.get("assets") or {}
    links = feature.get("links") or []
    stac_url = next((item.get("href") for item in links if item.get("rel") == "self"), None)
    polarizations = properties.get("sar:polarizations") or properties.get("sar:polarisation") or []
    return {
        "id": feature.get("id"),
        "collection": collection,
        "datetime": properties.get("datetime") or properties.get("start_datetime"),
        "platform": properties.get("platform"),
        "cloudCover": properties.get("eo:cloud_cover"),
        "orbitState": properties.get("sat:orbit_state"),
        "polarizations": polarizations if isinstance(polarizations, list) else [],
        "resolution": properties.get("gsd"),
        "bbox": feature.get("bbox"),
        "assetKeys": [key for key, asset in assets.items() if not asset.get("roles") or any(role in {"data", "visual"} for role in asset.get("roles", []))],
        "stacUrl": stac_url,
    }


async def catalogue_search(client: httpx.AsyncClient, request: CatalogSearchRequest, collection: str) -> list[dict]:
    payload: dict = {
        "collections": [collection],
        "bbox": request.aoi.bbox,
        "datetime": f"{request.startDate.isoformat()}T00:00:00Z/{request.endDate.isoformat()}T23:59:59Z",
        "limit": 8,
        "sortby": [{"field": "datetime", "direction": "desc"}],
    }
    if request.aoi.geometry:
        payload.pop("bbox")
        payload["intersects"] = request.aoi.geometry
    if collection == "sentinel-2-l2a":
        payload["query"] = {"eo:cloud_cover": {"lt": 100}}
    response = await client.post(CDSE_STAC_SEARCH, json=payload)
    response.raise_for_status()
    features = response.json().get("features", [])
    return [scene_from_feature(feature, collection) for feature in features]


async def cdse_access_token() -> str:
    cached_token = token_cache.get("access_token")
    if isinstance(cached_token, str) and time.time() < float(token_cache["expires_at"]):
        return cached_token

    client_id = os.getenv("CDSE_CLIENT_ID")
    client_secret = os.getenv("CDSE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Sentinel Hub credentials are not configured on this server")

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            CDSE_TOKEN_URL,
            data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if response.is_error:
            raise HTTPException(status_code=502, detail="Copernicus identity service rejected the configured client")
        payload = response.json()
        token = payload.get("access_token")
        if not isinstance(token, str):
            raise HTTPException(status_code=502, detail="Copernicus identity service did not return an access token")
        token_cache["access_token"] = token
        token_cache["expires_at"] = time.time() + max(int(payload.get("expires_in", 3600)) - 60, 60)
        return token


def evalscript_for(layer: Literal["true-color", "ndvi", "sar"]) -> tuple[str, str]:
    if layer == "ndvi":
        return (
            "sentinel-2-l2a",
            """//VERSION=3
function setup() { return { input: [\"B04\", \"B08\"], output: { bands: 3 } }; }
function evaluatePixel(s) {
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 0.0001);
  return ndvi < 0 ? [0.08, 0.10, 0.12] : [0.18 + ndvi * 0.22, 0.20 + ndvi * 0.55, 0.10];
}""",
        )
    if layer == "sar":
        return (
            "sentinel-1-grd",
            """//VERSION=3
function setup() { return { input: [\"VV\"], output: { bands: 3 } }; }
function evaluatePixel(s) {
  const value = Math.max(0, Math.min(1, (s.VV + 25) / 25));
  return [value, value, value];
}""",
        )
    return (
        "sentinel-2-l2a",
        """//VERSION=3
function setup() { return { input: [\"B02\", \"B03\", \"B04\"], output: { bands: 3 } }; }
function evaluatePixel(s) { return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02]; }""",
    )


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "version": "0.4.0",
        "catalogue": "public-stac",
        "imageryProcessing": bool(os.getenv("CDSE_CLIENT_ID") and os.getenv("CDSE_CLIENT_SECRET")),
        "hostedIntelligence": bool(
            os.getenv("OPENAI_API_KEY")
            and os.getenv("SUPABASE_URL")
            and os.getenv("SUPABASE_ANON_KEY")
        ),
    }


@app.post("/api/catalog/search")
async def search_catalogue(request: CatalogSearchRequest):
    collections = []
    if "sentinel-2" in request.sensors:
        collections.append("sentinel-2-l2a")
    if "sentinel-1" in request.sensors:
        collections.append("sentinel-1-grd")
    if not collections:
        raise HTTPException(status_code=422, detail="At least one Sentinel source must be selected")

    try:
        async with httpx.AsyncClient(timeout=40) as client:
            results = await asyncio.gather(*(catalogue_search(client, request, collection) for collection in collections))
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Copernicus STAC catalogue is unavailable") from error

    items = [item for result in results for item in result]
    items.sort(key=lambda item: item.get("datetime") or "", reverse=True)
    return {"source": "Copernicus Data Space STAC", "items": items}


@app.post("/api/imagery/render")
async def render_imagery(request: RenderRequest):
    token = await cdse_access_token()
    data_type, evalscript = evalscript_for(request.layer)
    payload = {
        "input": {
            "bounds": {"bbox": request.bbox, "properties": {"crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84"}},
            "data": [{
                "type": data_type,
                "dataFilter": {
                    "timeRange": {"from": f"{request.startDate.isoformat()}T00:00:00Z", "to": f"{request.endDate.isoformat()}T23:59:59Z"},
                    "mosaickingOrder": "leastCC",
                },
            }],
        },
        "output": {"width": request.width, "height": request.height, "responses": [{"identifier": "default", "format": {"type": "image/png"}}]},
        "evalscript": evalscript,
    }
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(CDSE_PROCESS_URL, json=payload, headers={"Authorization": f"Bearer {token}"})
    if response.is_error:
        raise HTTPException(status_code=502, detail="Sentinel Hub processing request failed")
    return Response(content=response.content, media_type="image/png", headers={"Cache-Control": "no-store", "X-Source": "Copernicus Data Space Sentinel Hub Process API"})

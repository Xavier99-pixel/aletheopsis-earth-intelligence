"""Approved research tasks: deterministic GIS, bounded jobs and immutable evidence."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pyproj import Transformer
from shapely.geometry import LineString, box, mapping
from shapely.ops import transform

from . import analysis_store as store
from .gis_engine import GISValidationError, analyse_river, validate_wgs84_geometry
from .security import SlidingWindowLimiter, verified_intelligence_subject
from .land import BoundedLandRoute

router = APIRouter(prefix="/api/analysis", tags=["Auditable GIS"], route_class=BoundedLandRoute)
worker_slots = asyncio.Semaphore(2)
limiter = SlidingWindowLimiter(8)
ALGORITHM = "aletheopsis-research-1.0.0"


class AOI(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    name: str = Field(min_length=1, max_length=180)
    bbox: list[float] = Field(min_length=4, max_length=4)
    source: Literal["map", "preset"] = "map"

    @model_validator(mode="after")
    def valid_bounds(self):
        w, s, e, n = self.bbox
        if not (-180 <= w < e <= 180 and -80 <= s < n <= 84) or e-w > 0.8 or n-s > 0.8:
            raise ValueError("Select a local AOI smaller than 0.8 degrees per side, between 80°S and 84°N.")
        return self


class RiverRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    question: str = Field(default="Calculate river geometry and distance screening", min_length=1, max_length=2000)
    aoi: AOI
    start_date: date
    end_date: date
    source_mode: Literal["sample", "geojson", "satellite"] = "satellite"
    buffer_m: float = Field(default=2000, ge=10, le=10000)
    observations: list[dict] = Field(default_factory=list, max_length=12)
    centerline: dict | None = None
    transect_spacing_m: float = Field(default=100, ge=20, le=2000)
    search_days: int = Field(default=7, ge=0, le=30)
    water_seed: list[float] | None = Field(default=None, min_length=2, max_length=2)

    @model_validator(mode="after")
    def validate_request(self):
        if self.start_date >= self.end_date:
            raise ValueError("Date A must precede Date B.")
        if self.end_date > date.today():
            raise ValueError("Observed analysis dates must not be in the future.")
        if self.source_mode == "satellite" and self.start_date < date(2017, 3, 28):
            raise ValueError("Use Sentinel-2 L2A dates from 28 March 2017 onward; regional availability varies.")
        if self.source_mode == "geojson" and not self.observations:
            raise ValueError("Upload dated water polygons with source metadata.")
        if len(json.dumps(self.observations)) > 1_500_000:
            raise ValueError("Observation geometry is too large; simplify or split the reach.")
        if self.water_seed is not None:
            x, y = self.water_seed
            w, s, e, n = self.aoi.bbox
            if not (w <= x <= e and s <= y <= n):
                raise ValueError("River seed must lie inside the selected AOI.")
        if self.centerline:
            validate_wgs84_geometry(self.centerline, ("LineString",))
        if self.source_mode == "geojson":
            for item in self.observations:
                if not isinstance(item.get("source"), str) or not item["source"].strip():
                    raise ValueError("Each observation needs a source description.")
                try:
                    observed = date.fromisoformat(item.get("date", ""))
                except (TypeError, ValueError) as exc:
                    raise ValueError("Each observation needs an ISO acquisition date.") from exc
                if not self.start_date <= observed <= self.end_date:
                    raise ValueError("Acquisition dates must lie inside the requested window.")
                validate_wgs84_geometry(item.get("geometry", {}))
                if item.get("valid_geometry"):
                    validate_wgs84_geometry(item["valid_geometry"])
        return self


async def subject(authorization: str | None):
    # Public samples contain only server-generated synthetic data. Every real run
    # uses verified identity, even if the legacy chat development switch is set.
    if os.getenv("INTELLIGENCE_ALLOW_UNAUTHENTICATED", "").lower() in {"1", "true", "yes", "on"}:
        raise HTTPException(503, "Disable INTELLIGENCE_ALLOW_UNAUTHENTICATED for stored research analyses.")
    return await verified_intelligence_subject(authorization)


def plan_for(request: RiverRequest):
    question = request.question.lower()
    intent = "land_monitor" if re.search(r"\b(land|parcel|authori[sz]|revenue)", question) else "river_temporal_analysis"
    return {
        "intent": intent, "planner": "versioned intent rules; approved functions only",
        "location": request.aoi.name, "requested_dates": [str(request.start_date), str(request.end_date)],
        "screening_buffers_m": sorted(set([500, 1000, request.buffer_m])),
        "steps": ["Validate local AOI and dates", "Discover imagery or validate uploaded water polygons",
                  "Mask cloud/shadow/nodata and record valid coverage", "Project geometry to local UTM",
                  "Calculate water area and unclipped observed water-edge length",
                  "Compare water extents on joint valid coverage", "Create distance screening zones",
                  "Publish calculation ledger, source evidence and limitations"],
        "requires": {
            "channel_volume": ["surveyed bathymetry/cross-sections and water stage in a common vertical datum"],
            "flood_prediction": ["validated gauge forecast", "calibrated hydraulic model", "terrain, releases and boundary conditions"],
            "land_status": ["server-verified department role", "authoritative dated parcel/authorization records"],
        },
        "prediction_status": "not_run_missing_validated_model",
    }


def sample_inputs(request: RiverRequest):
    """Illustrative metric geometry, deliberately unrelated to the actual river."""
    w, s, e, n = request.aoi.bbox
    lon, lat = (w+e)/2, (s+n)/2
    epsg = (32600 if lat >= 0 else 32700) + min(60, int((lon+180)//6)+1)
    forward = Transformer.from_crs(4326, epsg, always_xy=True).transform
    backward = Transformer.from_crs(epsg, 4326, always_xy=True).transform
    x, y = forward(lon, lat)
    aoi_local = transform(forward, box(w, s, e, n))
    width = min(aoi_local.bounds[2]-aoi_local.bounds[0], aoi_local.bounds[3]-aoi_local.bounds[1])
    reach = LineString([(x-width*.6,y-width*.12),(x,y+width*.04),(x+width*.6,y-width*.1)])
    observations = []
    for day, radius in [(request.start_date,width*.045),(request.end_date,width*.065)]:
        observations.append({"date": str(day), "geometry": mapping(transform(backward, reach.buffer(radius))),
                             "source": "SYNTHETIC teaching geometry; not a Krishna River observation", "scene_ids": [],
                             "resolution_m": None, "is_sample": True})
    return observations, mapping(transform(backward, reach))


def public_run(run: dict):
    return {k: v for k, v in run.items() if k not in {"owner", "cache_key"}}


@router.get("/capabilities")
async def capabilities():
    return {"version": ALGORITHM, "geometry": True, "sample": True,
            "satellite_processing": bool(os.getenv("CDSE_CLIENT_ID") and os.getenv("CDSE_CLIENT_SECRET")),
            "research_auth": bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_ANON_KEY")),
            "hydraulic_simulation": False, "validated_forecast": False, "sar_validation": False,
            "storage": "single-instance SQLite; configure ANALYSIS_DATA_DIR on a persistent disk for retention"}


@router.post("/plan")
async def plan(request: RiverRequest):
    return plan_for(request)


async def execute(run_id: str, request: RiverRequest):
    async with worker_slots:
        try:
            store.update_run(run_id, "FETCHING_DATA")
            observations = request.observations
            centerline = request.centerline
            evidence = []
            if request.source_mode == "sample":
                observations, centerline = sample_inputs(request)
            elif request.source_mode == "satellite":
                from .satellite import acquire_observations
                observations, evidence = await acquire_observations(request, run_id)
            store.update_run(run_id, "ANALYSING")
            result = await asyncio.to_thread(analyse_river, observations, mapping(box(*request.aoi.bbox)),
                                             sorted(set([500, 1000, request.buffer_m])), centerline, request.transect_spacing_m)
            store.update_run(run_id, "GENERATING_OUTPUT")
            result["analysis_id"] = run_id
            result["plan"] = plan_for(request)
            result["source_mode"] = request.source_mode
            result["evidence"] = evidence
            result["provenance"].update({"request": request.model_dump(mode="json"), "pipeline_version": ALGORITHM,
                                         "source_mode": request.source_mode, "source_assets": evidence})
            if evidence:
                for item in evidence:
                    result["calculations"].extend(item.get("calculations", []))
                result["limitations"].extend([
                    "Optical classification has not been independently validated with SAR or field data.",
                    "Cloud and invalid pixels are excluded; temporal differences use shared valid coverage.",
                    "Water components are selected by the supplied river seed, or the largest component in the AOI. Review the mask before treating it as the intended river.",
                ])
            store.update_run(run_id, "COMPLETE", result=result)
        except (ValueError, GISValidationError) as exc:
            store.update_run(run_id, "FAILED", error=str(exc)[:800])
        except HTTPException as exc:
            store.update_run(run_id, "FAILED", error=str(exc.detail)[:800])
        except Exception:
            store.update_run(run_id, "FAILED", error="Processing failed. No scientific result was issued. Check provider availability and server configuration, then retry.")


@router.post("/river", status_code=202)
async def river(request: RiverRequest, background: BackgroundTasks, authorization: str | None = Header(default=None)):
    owner = "public-synthetic" if request.source_mode == "sample" else await subject(authorization)
    await limiter.consume(owner)
    if request.source_mode == "satellite" and not (os.getenv("CDSE_CLIENT_ID") and os.getenv("CDSE_CLIENT_SECRET")):
        raise HTTPException(503, "Satellite processing needs server-side CDSE_CLIENT_ID and CDSE_CLIENT_SECRET. Use labelled sample geometry or upload surveyed water polygons.")
    body = request.model_dump(mode="json")
    # Sample jobs never persist caller-supplied private geometry.
    if request.source_mode == "sample":
        body.update(observations=[], centerline=None, question="Synthetic GIS demonstration")
        request = RiverRequest(**body)
    key = hashlib.sha256(json.dumps([ALGORITHM, body], sort_keys=True, allow_nan=False).encode()).hexdigest()
    # Live requests rediscover source acquisitions; do not reuse a date-only key
    # indefinitely while late catalogue acquisitions may still arrive.
    previous = None if request.source_mode == "satellite" else store.cached_run(owner, key)
    if previous:
        return {**public_run(previous), "cached": True}
    run_id = str(uuid.uuid4())
    try:
        store.create_run(run_id, owner, key, body)
    except ValueError as exc:
        raise HTTPException(429, str(exc)) from exc
    background.add_task(execute, run_id, request)
    return public_run(store.get_run(run_id))


async def owned_run(run_id: str, authorization: str | None):
    try:
        uuid.UUID(run_id)
    except ValueError as exc:
        raise HTTPException(404, "Analysis not found") from exc
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(404, "Analysis not found")
    if run["owner"] != "public-synthetic" and run["owner"] != await subject(authorization):
        raise HTTPException(404, "Analysis not found")
    return run


@router.get("/{run_id}")
async def get_analysis(run_id: str, authorization: str | None = Header(default=None)):
    return public_run(await owned_run(run_id, authorization))


@router.get("/{run_id}/{section}")
async def get_section(run_id: str, section: Literal["calculations", "provenance", "report"], authorization: str | None = Header(default=None)):
    run = await owned_run(run_id, authorization)
    if run["status"] != "COMPLETE":
        raise HTTPException(409, "The analysis has no completed result yet")
    return run["result"] if section == "report" else run["result"][section]


@router.get("/{run_id}/assets/{filename}")
async def get_asset(run_id: str, filename: str, authorization: str | None = Header(default=None)):
    await owned_run(run_id, authorization)
    if not re.fullmatch(r"[AB]-(source|mask|metadata)\.(tif|json)", filename):
        raise HTTPException(404, "Evidence asset not found")
    path = store.data_directory() / run_id / filename
    if not path.is_file():
        raise HTTPException(404, "Evidence asset not found")
    return FileResponse(path, filename=filename, headers={"Cache-Control": "private, no-store"})

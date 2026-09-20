"""Real Sentinel-2 pixels from CDSE; fixed evalscript, bounded local rasters.

Catalogue footprints never become water masks. All outputs retain source pixels,
mask, provider tile metadata and hashes. No arbitrary remote asset URLs are read.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import tarfile
from datetime import date, timedelta

import httpx
import numpy as np
from fastapi import HTTPException
from rasterio.features import geometry_mask, shapes
from rasterio.io import MemoryFile
from scipy import ndimage
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union

from .analysis_store import data_directory, update_run
from .gis_engine import project_local, water_index_mask

STAC = "https://stac.dataspace.copernicus.eu/v1/search"
PROCESS = "https://sh.dataspace.copernicus.eu/process/v1"
EVALSCRIPT = """//VERSION=3
function setup() {
  return {input:[{bands:["B03","B08","B11","SCL","dataMask"]}],
    mosaicking:"TILE",output:{bands:6,sampleType:"FLOAT32"}};
}
function evaluatePixel(samples) {
  for (var i=0;i<samples.length;i++) {
    var s=samples[i];
    if(s.dataMask===1 && [4,5,6,7].indexOf(s.SCL)>=0)
      return [s.B03,s.B08,s.B11,s.SCL,1,i+1];
  }
  return [0,0,0,0,0,0];
}
function updateOutputMetadata(scenes, inputMetadata, outputMetadata) {
  outputMetadata.userData={tiles:scenes.tiles,serviceVersion:inputMetadata.serviceVersion};
}
"""


async def discover_day(client, bbox, target: date, window: int, geometry=None):
    start, end = target-timedelta(days=window), min(date.today(), target+timedelta(days=window))
    payload = {"collections": ["sentinel-2-l2a"], "bbox": bbox,
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z", "limit": 100,
        "sortby": [{"field": "datetime", "direction": "asc"}]}
    if geometry:
        payload.pop("bbox")
        payload["intersects"] = geometry
    response = await client.post(STAC, json=payload)
    response.raise_for_status()
    items = response.json().get("features", [])
    candidates = []
    for item in items:
        raw = (item.get("properties") or {}).get("datetime", "")
        try:
            acquired = date.fromisoformat(raw[:10])
        except (ValueError, TypeError):
            continue
        if start <= acquired <= end:
            candidates.append((abs((acquired-target).days), acquired, item))
    if not candidates:
        raise ValueError(f"No Sentinel-2 L2A acquisition found within {window} days of {target}. Try a wider date tolerance or another source.")
    candidates.sort(key=lambda row: (row[0], row[1]))
    chosen = candidates[0][1]
    items_on_day = [row[2] for row in candidates if row[1] == chosen]
    return chosen, items_on_day, bool(response.json().get("links") and any(link.get("rel") == "next" for link in response.json()["links"]))


def unpack_response(content: bytes):
    if len(content) > 40_000_000:
        raise ValueError("Satellite evidence package exceeds the bounded processing limit.")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
        # Never extract paths onto disk; read exactly the two named regular files.
        values = {}
        for name in ("default.tif", "userdata.json"):
            member = archive.getmember(name)
            if not member.isfile() or member.size > 32_000_000:
                raise ValueError("Provider returned an invalid evidence package.")
            file = archive.extractfile(member)
            if file is None:
                raise ValueError("Provider evidence is missing.")
            values[name] = file.read()
    return values["default.tif"], json.loads(values["userdata.json"])


def process_raster(raw: bytes, metadata: dict, aoi: dict, seed: list[float] | None):
    projected, forward, inverse, epsg = project_local(aoi)
    with MemoryFile(raw) as memory, memory.open() as dataset:
        if dataset.count != 6 or dataset.width*dataset.height > 600_000 or dataset.crs is None or dataset.crs.to_epsg() != epsg:
            raise ValueError("Provider returned an unexpected raster grid or CRS.")
        bands = dataset.read()
        affine = dataset.transform
        profile = dataset.profile.copy()
    inside = geometry_mask([mapping(projected)], out_shape=bands.shape[1:], transform=affine, invert=True)
    valid = inside & (bands[4] == 1) & np.isin(bands[3], [4, 5, 6, 7]) & np.isfinite(bands[:3]).all(axis=0)
    valid &= ((bands[0]+bands[1]) > 1e-12) & ((bands[0]+bands[2]) > 1e-12)
    valid &= (bands[:3] >= 0).all(axis=0)
    coverage = float(valid.sum() / max(1, inside.sum()))
    if valid.sum() < 100 or coverage < 0.5:
        raise ValueError(f"Only {coverage:.1%} of the selected AOI has usable clear pixels. At least 50% coverage and 100 valid pixels are required; choose another date.")
    pixel_area = abs(affine.a*affine.e-affine.b*affine.d)
    mndwi = water_index_mask(bands[0], bands[2], valid, index="MNDWI", pixel_area_m2=pixel_area)
    ndwi = water_index_mask(bands[0], bands[1], valid, index="NDWI", pixel_area_m2=pixel_area)
    candidate = np.array(mndwi["water_mask"], dtype=bool)
    components, count = ndimage.label(candidate)  # four-connected components
    sizes = np.bincount(components.ravel())
    sizes[0] = 0
    sizes[sizes < 4] = 0
    if not count or not sizes.max():
        raise ValueError("No coherent water component remains after classification. Review imagery and AOI; no river extent is issued.")
    if seed is not None:
        x, y = forward.transform(*seed)
        col, row = (~affine) * (x, y)
        r, c = math.floor(row), math.floor(col)
        if not (0 <= r < components.shape[0] and 0 <= c < components.shape[1]):
            raise ValueError("River seed is outside the raster.")
        selected = components[r,c]
        if selected == 0 or sizes[selected] == 0:
            raise ValueError("The river seed is not in a classified water component on this date. Review the mask or select another seed/date.")
    else:
        selected = int(np.argmax(sizes))
    water = components == selected
    def polygon(mask):
        parts = [shape(geom) for geom, value in shapes(mask.astype("uint8"), mask=mask, transform=affine) if value == 1]
        return unary_union(parts).intersection(projected)
    water_polygon, valid_polygon = polygon(water), polygon(valid)
    if water_polygon.is_empty:
        raise ValueError("Classified water does not intersect the selected AOI.")
    mask = np.where(valid, water.astype("uint8"), 255).astype("uint8")
    profile.update(count=1, dtype="uint8", nodata=255, compress="deflate")
    with MemoryFile() as output:
        with output.open(**profile) as dest:
            dest.write(mask, 1)
        mask_bytes = output.read()
    used_indices = sorted(set(int(v)-1 for v in bands[5][valid].ravel() if v >= 1))
    tiles = metadata.get("tiles", [])
    if not isinstance(tiles, list) or any(index >= len(tiles) for index in used_indices):
        raise ValueError("Raster source indices cannot be matched to provider tile metadata.")
    used_tiles = [tiles[i] for i in used_indices]
    if not used_tiles:
        raise ValueError("Provider returned no traceable source tile identifiers.")
    agreement = int((np.array(ndwi["water_mask"], bool) & water).sum()) / int(water.sum())
    details = {"valid_coverage_fraction": coverage, "valid_pixel_count": int(valid.sum()),
        "selected_water_pixel_count": int(water.sum()), "pixel_area_m2": pixel_area,
        "raster_water_area_m2": int(water.sum())*pixel_area, "vector_clipped_water_area_m2": water_polygon.area,
        "mndwi_threshold": mndwi["threshold"], "ndwi_threshold": ndwi["threshold"],
        "threshold_method": mndwi["threshold_method"], "ndwi_agreement_with_selected_water": agreement,
        "selection": "seed-connected component" if seed else "largest four-connected component",
        "minimum_component_pixels": 4, "cloud_mask": "SCL classes 4,5,6,7 only; dataMask=1; finite positive index denominators",
        "resampling": "NEAREST for all bands on one projected grid; effective information resolution at least 20 m",
        "resolution_m": [abs(affine.a), abs(affine.e)], "calculation_crs": f"EPSG:{epsg}",
        "used_tiles": used_tiles, "classification_accuracy": None, "sar_validation": "not_run"}
    return mapping(transform(inverse.transform, water_polygon)), mapping(transform(inverse.transform, valid_polygon)), details, mask_bytes


async def acquire_observations(request, run_id):
    from .main import cdse_access_token
    token = await cdse_access_token()
    aoi = request.aoi.geometry or mapping(box(*request.aoi.bbox))
    projected, _, _, epsg = project_local(aoi)
    minx, miny, maxx, maxy = projected.bounds
    resolution = max(20, math.ceil(max(maxx-minx, maxy-miny)/512))
    width, height = math.ceil((maxx-minx)/resolution), math.ceil((maxy-miny)/resolution)
    bounds = [minx, miny, minx+width*resolution, miny+height*resolution]
    directory = data_directory() / run_id
    directory.mkdir(mode=0o700, exist_ok=True)
    observations, evidence = [], []
    async with httpx.AsyncClient(timeout=90, follow_redirects=False) as client:
        for label, target in [("A", request.start_date), ("B", request.end_date)]:
            update_run(run_id, "FETCHING_DATA")
            acquired, candidates, truncated = await discover_day(client, request.aoi.bbox, target, request.search_days, request.aoi.geometry)
            if observations and str(acquired) <= observations[-1]["date"]:
                raise ValueError("Both date windows selected the same or reversed acquisitions. Separate Date A and Date B or reduce the search tolerance.")
            payload = {"input": {"bounds": {"bbox": bounds,
                "properties": {"crs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}"}},
                "data": [{"type": "sentinel-2-l2a", "dataFilter": {"timeRange": {
                    "from": f"{acquired}T00:00:00Z", "to": f"{acquired}T23:59:59Z"}, "mosaickingOrder": "leastCC"},
                    "processing": {"upsampling": "NEAREST", "downsampling": "NEAREST", "harmonizeValues": True}}]},
                "output": {"width": width, "height": height, "responses": [
                    {"identifier": "default", "format": {"type": "image/tiff"}},
                    {"identifier": "userdata", "format": {"type": "application/json"}}]}, "evalscript": EVALSCRIPT}
            response = await client.post(PROCESS, json=payload, headers={"Authorization": f"Bearer {token}", "Accept": "application/x-tar"})
            if response.is_error:
                raise HTTPException(502, "Copernicus pixel processing failed. Check server credentials, data coverage and processing quota.")
            raw, metadata = unpack_response(response.content)
            update_run(run_id, "PREPROCESSING")
            water, valid, details, mask = await asyncio.to_thread(process_raster, raw, metadata, aoi, request.water_seed)
            tile_ids = [str(tile.get("dataPath") or tile.get("shId") or "") for tile in details["used_tiles"]]
            if any(not identifier for identifier in tile_ids):
                raise ValueError("A contributing source tile has no identifier.")
            observation = {"date": str(acquired), "geometry": water, "valid_geometry": valid,
                "source": "Copernicus Sentinel-2 L2A; MNDWI/Otsu and SCL masking; unvalidated water classification",
                "scene_ids": tile_ids, "resolution_m": resolution, "is_sample": False}
            observations.append(observation)
            paths = {"source": directory/f"{label}-source.tif", "mask": directory/f"{label}-mask.tif", "metadata": directory/f"{label}-metadata.json"}
            paths["source"].write_bytes(raw)
            paths["mask"].write_bytes(mask)
            record = {"label": label, "requested_date": str(target), "acquisition_date": str(acquired),
                "catalogue_scene_ids": [item["id"] for item in candidates], "contributing_tile_ids": tile_ids,
                "catalogue_candidates_truncated": truncated, "source": "Copernicus Data Space Sentinel Hub",
                "source_url": "https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html",
                "provider_metadata": metadata, "processing": details,
                "sha256": {"source": hashlib.sha256(raw).hexdigest(), "mask": hashlib.sha256(mask).hexdigest()},
                "assets": {kind: f"/api/analysis/{run_id}/assets/{path.name}" for kind,path in paths.items()},
                "calculations": [{"id": f"pixel_area_{label}", "label": f"Classified raster area · {acquired}",
                    "value": details["raster_water_area_m2"], "unit": "m²", "evidence_level": "DERIVED",
                    "formula": "A = selected_water_pixel_count × pixel_area_m2", "inputs": details,
                    "method": "MNDWI Otsu; SCL cloud/shadow/nodata mask; connected component selection",
                    "source": tile_ids, "uncertainty": "Classification accuracy unvalidated; NDWI agreement is diagnostic, not a probability. Raster boundary cells use pixel-centre inclusion; vector geometry is clipped to the AOI."}]}
            paths["metadata"].write_text(json.dumps(record, indent=2, allow_nan=False))
            evidence.append(record)
    return observations, evidence

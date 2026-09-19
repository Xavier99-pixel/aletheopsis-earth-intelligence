"""Explicit-input scientific tools; no model execution or hidden assumed data."""
from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pyproj import Transformer
from shapely.ops import transform

from .analysis import subject
from .gis_engine import (GISValidationError, shoreline_rates, cross_section_volume,
                         depth_volume, dem_difference_volume, water_index_mask, project_local, validate_wgs84_geometry)
from .land import BoundedLandRoute
from .security import SlidingWindowLimiter

router = APIRouter(prefix="/api/gis", tags=["Scientific calculators"], route_class=BoundedLandRoute)
calculator_slots = asyncio.Semaphore(2)
calculator_limiter = SlidingWindowLimiter(20)


class ToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    operation: Literal["cross_section_volume", "depth_volume", "dem_difference_volume", "bank_change", "water_index", "exposure"]
    source: str = Field(min_length=3, max_length=500)
    parameters: dict
    is_sample: bool = False


def exposure(parameters):
    allowed = {"hazard_geometry", "assets", "hazard_kind"}
    if set(parameters) - allowed:
        raise GISValidationError("Unknown exposure parameters")
    kind = parameters.get("hazard_kind")
    if kind not in {"observed_water", "screening", "modelled_inundation"}:
        raise GISValidationError("Declare hazard_kind as observed_water, screening or modelled_inundation")
    hazard = parameters.get("hazard_geometry")
    projected, forward, _, epsg = project_local(hazard)
    assets = parameters.get("assets", [])
    if not isinstance(assets, list) or not 1 <= len(assets) <= 300:
        raise GISValidationError("Supply 1–300 sourced asset footprints or lines")
    rows = []
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("id"), str) or not asset["id"] or len(asset["id"]) > 160:
            raise GISValidationError("Every asset needs an identifier")
        geometry = validate_wgs84_geometry(asset.get("geometry"), ("Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point"))
        local = transform(forward.transform, geometry)
        if local.distance(projected) > 150_000:
            raise GISValidationError("Exposure assets must be local to the hazard geometry")
        intersection = local.intersection(projected)
        area = local.geom_type in {"Polygon", "MultiPolygon"}
        rows.append({"id": asset["id"], "intersects": not intersection.is_empty,
                     "exposed_area_m2": intersection.area if area else None,
                     "exposed_length_m": intersection.length if "LineString" in local.geom_type else None})
    return {"assets": rows, "intersecting_asset_count": sum(item["intersects"] for item in rows),
            "calculation_crs": f"EPSG:{epsg}", "hazard_kind": kind,
            "formula": "Exposure = asset geometry ∩ supplied hazard/screening geometry",
            "limitations": ["Count means geometric intersection, not damage, occupancy or casualties.",
                            "Screening exposure has no flood probability or depth; verify the supplied hazard source."]}


FUNCTIONS = {"cross_section_volume": cross_section_volume, "depth_volume": depth_volume,
             "dem_difference_volume": dem_difference_volume, "bank_change": shoreline_rates,
             "water_index": water_index_mask}


def calculate(request: ToolRequest):
    try:
        result = exposure(request.parameters) if request.operation == "exposure" else FUNCTIONS[request.operation](**request.parameters)
    except TypeError as exc:
        raise GISValidationError("Parameters do not match this calculator. Consult the documented input schema.") from exc
    try:
        json.dumps(result, allow_nan=False)
    except (ValueError, OverflowError) as exc:
        raise GISValidationError("Calculation exceeded finite numeric limits; check input values and units.") from exc
    return {"operation": request.operation, "source": request.source,
            "evidence_level": "EXAMPLE" if request.is_sample else "DERIVED",
            "inputs": request.parameters, "result": result,
            "source_verification": "Caller-supplied evidence; not independently verified",
            "algorithm_version": "aletheopsis-explicit-calculators-1.0.0"}


@router.post("/calculate")
async def calculator(request: ToolRequest, authorization: str | None = Header(default=None)):
    owner = "public-calculator-example" if request.is_sample else await subject(authorization)
    await calculator_limiter.consume(owner)
    try:
        async with calculator_slots:
            return await asyncio.to_thread(calculate, request)
    except GISValidationError as exc:
        raise HTTPException(422, str(exc)) from exc

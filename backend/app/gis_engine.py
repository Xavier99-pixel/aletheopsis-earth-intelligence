"""Bounded, auditable GIS calculations; no inferred bathymetry or flood forecast.

Public geometry inputs are two-dimensional EPSG:4326 GeoJSON. Measurements are
made in one local WGS84 UTM CRS. The raster helpers require prealigned arrays:
they deliberately do not imply that catalogue discovery processes satellite data.
"""

from __future__ import annotations

import math
import re
from datetime import date
from typing import Any

import numpy as np
from pyproj import CRS, Geod, Transformer
from scipy.stats import linregress, t as student_t
from shapely.geometry import GeometryCollection, LineString, Point, Polygon, mapping, shape
from shapely.ops import transform, unary_union

ALGORITHM_VERSION = "aletheopsis-gis-1.0.0"
MAX_VERTICES = 20_000
MAX_OBSERVATIONS = 40
MAX_ARRAY_CELLS = 1_000_000
MAX_LOCAL_SPAN_M = 100_000
BANK_CLIP_TOLERANCE_M = 0.1
GEOD = Geod(ellps="WGS84")


class GISValidationError(ValueError):
    """Input is outside the documented scientific or resource limits."""


def _finite_number(value: Any, label: str, *, minimum=None, maximum=None) -> float:
    if isinstance(value, (bool, str)) or not isinstance(value, (int, float, np.number)):
        raise GISValidationError(f"{label} must be a finite number")
    value = float(value)
    if not math.isfinite(value):
        raise GISValidationError(f"{label} must be finite")
    if minimum is not None and value < minimum:
        raise GISValidationError(f"{label} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise GISValidationError(f"{label} must be at most {maximum}")
    return value


def _date(value: Any) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise GISValidationError("Dates must use YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise GISValidationError("Invalid calendar date") from exc


def validate_wgs84_geometry(geojson: dict, allowed_types=("Polygon", "MultiPolygon")):
    """Reject ambiguous CRSs, invalid rings, Z coordinates and excessive geometry."""
    if not isinstance(geojson, dict) or geojson.get("type") not in allowed_types:
        raise GISValidationError(f"Geometry must be one of: {', '.join(allowed_types)}")
    if "crs" in geojson:
        raise GISValidationError("GeoJSON must be EPSG:4326 longitude/latitude without a crs override")
    count = 0

    def visit(values, depth=0):
        nonlocal count
        if depth > 5 or not isinstance(values, (list, tuple)) or not values:
            raise GISValidationError("Invalid or empty coordinate structure")
        if isinstance(values[0], (int, float, np.number)):
            if len(values) != 2:
                raise GISValidationError("Coordinates must contain exactly longitude and latitude")
            _finite_number(values[0], "longitude", minimum=-180, maximum=180)
            _finite_number(values[1], "latitude", minimum=-80, maximum=84)
            count += 1
            if count > MAX_VERTICES:
                raise GISValidationError(f"Geometry exceeds {MAX_VERTICES} vertices")
        else:
            for value in values:
                visit(value, depth + 1)

    visit(geojson.get("coordinates"))
    # Shapely closes open rings silently. Require explicit GeoJSON ring closure.
    if geojson["type"] in ("Polygon", "MultiPolygon"):
        polygons = [geojson["coordinates"]] if geojson["type"] == "Polygon" else geojson["coordinates"]
        for polygon in polygons:
            for ring in polygon:
                if len(ring) < 4 or ring[0] != ring[-1]:
                    raise GISValidationError("Polygon rings must have at least four positions and be closed")
    try:
        geometry = shape(geojson)
    except (ValueError, TypeError, IndexError) as exc:
        raise GISValidationError("Could not parse geometry") from exc
    if geometry.is_empty or not geometry.is_valid:
        raise GISValidationError("Geometry must be nonempty and topologically valid")
    if geometry.bounds[2] - geometry.bounds[0] > 180:
        raise GISValidationError("Antimeridian-crossing geometry is unsupported; split into local AOIs")
    return geometry


def project_local(aoi: dict):
    """Return (projected AOI, forward transformer, inverse transformer, EPSG)."""
    geometry = validate_wgs84_geometry(aoi)
    west, south, east, north = geometry.bounds
    distances = [
        GEOD.inv(west, south, east, north)[2],
        GEOD.inv(west, north, east, south)[2],
        GEOD.inv(west, south, east, south)[2],
        GEOD.inv(west, north, east, north)[2],
    ]
    if max(distances) > MAX_LOCAL_SPAN_M:
        raise GISValidationError("AOI span must be 100 km or less; split large studies into local AOIs")
    center = geometry.centroid
    zone = min(60, max(1, int((center.x + 180) // 6) + 1))
    epsg = (32600 if center.y >= 0 else 32700) + zone
    forward = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(epsg), always_xy=True)
    inverse = Transformer.from_crs(CRS.from_epsg(epsg), CRS.from_epsg(4326), always_xy=True)
    projected = transform(forward.transform, geometry)
    if projected.area < 1:
        raise GISValidationError("AOI area must be at least 1 square metre")
    return projected, forward, inverse, epsg


def _project_near(geojson, forward, aoi, allowed_types=("Polygon", "MultiPolygon")):
    geometry = validate_wgs84_geometry(geojson, allowed_types)
    projected = transform(forward.transform, geometry)
    if not all(math.isfinite(v) for v in projected.bounds):
        raise GISValidationError("Projection produced invalid coordinates")
    center = aoi.centroid
    west, south, east, north = projected.bounds
    if any(math.hypot(x - center.x, y - center.y) > 150_000 for x, y in ((west, south), (east, north))):
        raise GISValidationError("Input geometry must lie within 150 km of the local AOI")
    return projected


def _polygons(geometry):
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    if hasattr(geometry, "geoms"):
        return unary_union([_polygons(g) for g in geometry.geoms])
    return GeometryCollection()


def _feature(geometry, inverse, properties):
    return {"type": "Feature", "geometry": mapping(transform(inverse.transform, geometry)), "properties": properties}


def _layer(identifier, label, features, evidence):
    return {"id": identifier, "label": label, "evidence_level": evidence,
            "geojson": {"type": "FeatureCollection", "features": features}}


def _metric(identifier, label, value, unit, formula, inputs, method, source, uncertainty, evidence="DERIVED"):
    return {"id": identifier, "label": label, "value": value, "unit": unit,
            "evidence_level": evidence, "formula": formula, "inputs": inputs,
            "method": method, "source": source, "uncertainty": uncertainty}


def analyse_river(observations: list[dict], aoi: dict, buffers_m: list[float],
                  centerline: dict | None = None, transect_spacing_m: float = 100) -> dict:
    """Measure supplied dated water polygons; never assume imagery was retrieved.

    Width is the summed wetted intersection along a perpendicular transect, not
    bankfull width. Water-footprint change is not automatically geomorphic change.
    """
    if not isinstance(observations, list) or not 1 <= len(observations) <= MAX_OBSERVATIONS:
        raise GISValidationError(f"Provide between 1 and {MAX_OBSERVATIONS} dated observations")
    if not isinstance(buffers_m, list) or len(buffers_m) > 8:
        raise GISValidationError("Provide at most eight screening buffer distances")
    buffers = sorted(set(_finite_number(v, "buffer distance", minimum=1, maximum=20_000) for v in buffers_m))
    spacing = _finite_number(transect_spacing_m, "transect spacing", minimum=1, maximum=10_000)
    projected_aoi, forward, inverse, epsg = project_local(aoi)
    measured = []
    seen_dates = set()
    total_vertices = 0
    for observation in observations:
        if not isinstance(observation, dict):
            raise GISValidationError("Each observation must be an object")
        stamp = _date(observation.get("date"))
        if stamp in seen_dates:
            raise GISValidationError("Observation dates must be unique; mosaic same-date scenes before analysis")
        seen_dates.add(stamp)
        source = observation.get("source")
        if not isinstance(source, str) or not source.strip() or len(source) > 500:
            raise GISValidationError("Each observation needs a source of 1–500 characters")
        scene_ids = observation.get("scene_ids", [])
        if not isinstance(scene_ids, list) or len(scene_ids) > 100 or any(not isinstance(v, str) or not v or len(v) > 300 for v in scene_ids):
            raise GISValidationError("scene_ids must contain at most 100 identifiers of 1–300 characters")
        if not isinstance(observation.get("is_sample", False), bool):
            raise GISValidationError("is_sample must be a boolean")
        resolution = observation.get("resolution_m")
        if resolution is not None:
            resolution = _finite_number(resolution, "resolution", minimum=0.001, maximum=10_000)
        water = _project_near(observation.get("geometry"), forward, projected_aoi)
        total_vertices += sum(len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors)
                              for p in ([water] if water.geom_type == "Polygon" else water.geoms))
        if total_vertices > 100_000:
            raise GISValidationError("Combined observations exceed 100,000 vertices")
        coverage = (_project_near(observation["valid_geometry"], forward, projected_aoi).intersection(projected_aoi)
                    if observation.get("valid_geometry") else projected_aoi)
        clipped = _polygons(water.intersection(coverage))
        if clipped.is_empty or clipped.area < 0.01:
            raise GISValidationError("Every supplied water polygon must overlap the AOI with positive area")
        edges = clipped.boundary.difference(coverage.boundary.buffer(BANK_CLIP_TOLERANCE_M))
        measured.append({"date": stamp.isoformat(), "water": clipped, "edges": edges, "coverage": coverage,
                         "valid_coverage_m2": coverage.area,
                         "source": source.strip(), "scene_ids": scene_ids, "resolution_m": resolution,
                         "is_sample": observation.get("is_sample", False)})
    measured.sort(key=lambda item: item["date"])
    sample = any(item["is_sample"] for item in measured)
    evidence = "EXAMPLE" if sample else "DERIVED"
    uncertainty = ("Positional and classification uncertainty are not quantified; pixel size is not an accuracy estimate. "
                   "UTM grid measurements are local planar estimates, not cadastral survey measurements.")
    limitations = [
        "Geometry is measured from the supplied dated water masks/polygons; their source and any executed satellite processing are recorded separately in provenance.",
        "Water-edge length includes island edges and is unsided; it is not river centerline length or separately identified left/right bank length.",
        f"AOI-generated boundaries and natural edges within {BANK_CLIP_TOLERANCE_M} m of the AOI boundary are excluded from water-edge length.",
        "Water extent and width depend on discharge, season, tide, reservoir operations, image resolution and cloud/shadow classification.",
        "Water-footprint gain/loss cannot independently establish erosion, accretion, a legal river boundary or land ownership.",
        "Distance buffers are proximity screening zones, not flood extents, probabilities, forecasts or legal setback determinations.",
        "No flood forecast is computed: terrain, surveyed bathymetry, gauge/discharge boundaries, rainfall, hydraulic calibration and validation are required.",
        "Channel volume is unavailable from two-dimensional water boundaries alone; measured depths or compatible bed elevations and water levels are required.",
    ]
    if sample:
        limitations.insert(0, "EXAMPLE DATA: one or more supplied observations are illustrative; all combined results must remain labelled as examples.")
    metrics, layers, temporal = [], [], []
    for item in measured:
        stamp = item["date"]
        inputs = {"date": stamp, "calculation_crs": f"EPSG:{epsg}", "resolution_m": item["resolution_m"],
                  "scene_ids": item["scene_ids"], "is_sample": item["is_sample"], "aoi_clip": True}
        parts = [item["water"]] if item["water"].geom_type == "Polygon" else list(item["water"].geoms)
        area_components = [{"outer_ring_area_m2": Polygon(p.exterior).area,
                            "hole_area_m2": sum(Polygon(r).area for r in p.interiors),
                            "net_polygon_area_m2": p.area} for p in parts]
        edges = list(item["edges"].geoms) if hasattr(item["edges"], "geoms") else [item["edges"]]
        length_components = [edge.length for edge in edges if not edge.is_empty]
        metrics.extend([
            _metric(f"water_area_{stamp}", f"Water area · {stamp}", item["water"].area, "m²", "A = Σ (outer ring area − hole areas); ring area = |Σ(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)| / 2",
                    {**inputs, "polygon_components": area_components, "geometry_layer_id": f"water_{stamp}", "m2_to_km2_divisor": 1000000},
                    "Area of clipped water polygons in local UTM, retaining holes", item["source"], uncertainty, evidence),
            _metric(f"water_edge_length_{stamp}", f"Observed water-edge length · {stamp}", item["edges"].length, "m",
                    "L = Σ √((xᵢ₊₁−xᵢ)²+(yᵢ₊₁−yᵢ)²) over retained water-edge segments",
                    {**inputs, "clip_tolerance_m": BANK_CLIP_TOLERANCE_M, "boundary_component_lengths_m": length_components,
                     "geometry_layer_id": f"water_edges_{stamp}", "excluded_aoi_or_nodata_edges": True},
                    "Unsided water boundary; AOI clipping edges excluded", item["source"], uncertainty, evidence),
        ])
        layers.append(_layer(f"water_{stamp}", f"Water footprint · {stamp}", [_feature(item["water"], inverse, {"date": stamp, "is_sample": item["is_sample"]})], evidence))
        if not item["edges"].is_empty:
            layers.append(_layer(f"water_edges_{stamp}", f"Observed water edges · {stamp}", [_feature(item["edges"], inverse, {"date": stamp})], evidence))
        temporal.append({"date": stamp, "water_area_m2": item["water"].area, "water_edge_length_m": item["edges"].length,
                         "source": item["source"], "scene_ids": item["scene_ids"], "is_sample": item["is_sample"]})
    for before, after in zip(measured, measured[1:]):
        common = before["coverage"].intersection(after["coverage"])
        if common.is_empty or common.area < 1:
            limitations.append(f"No shared observed coverage for {before['date']}–{after['date']}; change is withheld.")
            continue
        gained = after["water"].difference(before["water"]).intersection(common)
        lost = before["water"].difference(after["water"]).intersection(common)
        stamp = f"{before['date']}_{after['date']}"
        inputs = {"from_date": before["date"], "to_date": after["date"], "gained_m2": gained.area, "lost_m2": lost.area,
                  "common_valid_area_m2": common.area, "before_water_on_common_m2": before["water"].intersection(common).area,
                  "after_water_on_common_m2": after["water"].intersection(common).area}
        source = f"{before['source']} → {after['source']}"
        for key, label, value, formula in [
            ("gained", "Newly mapped water area", gained.area, "A_gain = area(W₂ \\ W₁)"),
            ("lost", "Formerly mapped water area", lost.area, "A_loss = area(W₁ \\ W₂)"),
            ("net", "Net water-area change", gained.area - lost.area, "ΔA = A_gain − A_loss = A₂ − A₁"),
        ]:
            metrics.append(_metric(f"change_{key}_{stamp}", f"{label} · {before['date']}–{after['date']}", value, "m²", formula,
                                   inputs, "Consecutive-date polygon overlay restricted to shared valid observation coverage", source, uncertainty, evidence))
        for identifier, geometry, label in [("gained", gained, "Newly mapped water"), ("lost", lost, "Formerly mapped water")]:
            if not geometry.is_empty:
                layers.append(_layer(f"{identifier}_{stamp}", label, [_feature(geometry, inverse, inputs)], evidence))
    latest = measured[-1]
    for radius in buffers:
        # The AOI limits observability; do not invent shores beyond its boundary.
        screened = latest["edges"].buffer(radius, quad_segs=32).intersection(latest["coverage"]).difference(latest["water"])
        inputs = {"distance_m": radius, "reference_date": latest["date"], "land_only": True, "clipped_to_aoi": True,
                  "buffer_arc_segments_per_quadrant": 32, "is_flood_prediction": False, "restricted_to_valid_coverage": True}
        metrics.append(_metric(f"proximity_area_{radius:g}", f"Land within {radius:g} m of observed water edges", screened.area, "m²",
                               "A_d = area((buffer(E_latest, d) ∩ AOI) \\ W_latest)", inputs,
                               "Planar distance-to-observed-edge screening, restricted to the AOI", latest["source"],
                               "Incomplete near the AOI boundary: shores outside the AOI are unknown. Distance alone does not determine flooding.", evidence))
        layers.append(_layer(f"proximity_{radius:g}", f"{radius:g} m proximity screen · not a flood map",
                             [] if screened.is_empty else [_feature(screened, inverse, inputs)], evidence))
    widths = []
    if centerline is not None:
        line = _project_near(centerline, forward, projected_aoi, ("LineString",))
        if not line.is_simple or line.length < 1 or not line.intersects(projected_aoi):
            raise GISValidationError("Centerline must be a simple line at least 1 m long that intersects the AOI")
        if math.ceil(line.length / spacing) > 1000:
            raise GISValidationError("Transect count exceeds 1,000; increase transect spacing")
        reach_length = line.intersection(projected_aoi).length
        metrics.append(_metric("supplied_centerline_length", "Supplied river centerline length", reach_length, "m",
                               "L = Σ √((xᵢ₊₁−xᵢ)² + (yᵢ₊₁−yᵢ)²)",
                               {"calculation_crs": f"EPSG:{epsg}", "clipped_to_aoi": True},
                               "Local UTM length of the supplied centerline inside the AOI", "User-supplied centerline",
                               "Centerline location and representativeness are not independently verified.", evidence))
        layers.append(_layer("supplied_centerline", "Supplied river centerline", [_feature(line.intersection(projected_aoi), inverse, {})], evidence))
        chainages = np.arange(spacing / 2, line.length, spacing)
        if not len(chainages):
            chainages = np.array([line.length / 2])
        west, south, east, north = projected_aoi.bounds
        half_length = math.hypot(east - west, north - south) + 1
        transect_features = []
        for station in chainages:
            point = line.interpolate(float(station))
            if not projected_aoi.contains(point):
                continue
            tangent_length = min(10, spacing / 4, line.length / 4)
            start = line.interpolate(max(0, station - tangent_length))
            end = line.interpolate(min(line.length, station + tangent_length))
            dx, dy = end.x - start.x, end.y - start.y
            length = math.hypot(dx, dy)
            if length < 1e-8:
                continue
            px, py = -dy / length, dx / length
            transect = LineString([(point.x - px * half_length, point.y - py * half_length),
                                   (point.x + px * half_length, point.y + py * half_length)]).intersection(projected_aoi)
            for item in measured:
                wet = transect.intersection(item["water"])
                censored = not wet.is_empty and wet.distance(item["coverage"].boundary) <= BANK_CLIP_TOLERANCE_M
                row = {"date": item["date"], "chainage_m": float(station), "summed_wetted_width_m": wet.length,
                       "censored_at_aoi": bool(censored)}
                widths.append(row)
                if item is latest:
                    transect_features.append(_feature(transect, inverse, row))
        for item in measured:
            complete = [row["summed_wetted_width_m"] for row in widths if row["date"] == item["date"] and not row["censored_at_aoi"]]
            metrics.append(_metric(f"mean_wetted_width_{item['date']}", f"Mean sampled wetted width · {item['date']}",
                                   float(np.mean(complete)) if complete else None, "m", "wᵢ = Σ length(Tᵢ ∩ W); mean(wᵢ) for uncensored Tᵢ",
                                   {"transect_spacing_m": spacing, "complete_transect_count": len(complete), "date": item["date"]},
                                   "Perpendicular transects along a supplied centerline; sums separate wet channels; excludes AOI-censored sections",
                                   item["source"], "Results depend on centerline geometry and sampling; this is not bankfull or maximum width.", evidence))
        layers.append(_layer("width_transects", "Sampled cross sections at latest observation", transect_features, evidence))
    else:
        limitations.append("No centerline supplied: cross-section widths are not calculated. Polygon shape alone does not define transect orientation.")
    for identifier, label, unit, requirement in [
        ("channel_volume", "Channel water volume", "m³", "Surveyed depths or bed elevations and water levels in a common vertical datum"),
        ("flood_inundation_area", "Predicted flood inundation area", "m²", "Validated hydrologic and hydraulic model with terrain and flow boundary conditions"),
    ]:
        metrics.append(_metric(identifier, label, None, unit, "Not computed", {"required_input": requirement},
                               "Unavailable: necessary measurements/model inputs were not supplied", "No supporting source supplied",
                               "No estimate or confidence interval can be justified from water polygons alone.", evidence))
    return {"metrics": metrics, "calculations": metrics.copy(), "layers": layers, "temporal": temporal, "widths": widths,
            "provenance": {"input_crs": "EPSG:4326", "calculation_crs": f"EPSG:{epsg}", "algorithm_version": ALGORITHM_VERSION,
                           "measurement_model": "local UTM planar grid", "aoi_area_m2": projected_aoi.area,
                           "aoi_max_span_m": MAX_LOCAL_SPAN_M, "bank_clip_tolerance_m": BANK_CLIP_TOLERANCE_M,
                           "is_sample": sample, "evidence_level": evidence,
                           "observations": [{k: v for k, v in item.items() if k not in {"water", "edges", "coverage"}} for item in measured]},
            "limitations": limitations}


def shoreline_rates(samples: list[dict]) -> dict:
    """NSM/EPR/LRR for manually associated, consistently signed transect positions.

    Inputs: [{date: YYYY-MM-DD, position_m: signed float, uncertainty_m: float?}].
    LRR 95% CI uses Student's t and independent, homoscedastic residuals. No
    forecast or universal error model is inferred from observation resolution.
    """
    if not isinstance(samples, list) or not 2 <= len(samples) <= 1000:
        raise GISValidationError("Rates require 2–1,000 dated signed positions on the same transect")
    rows = []
    for sample in samples:
        if not isinstance(sample, dict):
            raise GISValidationError("Transect samples must be objects")
        stamp = _date(sample.get("date"))
        position = _finite_number(sample.get("position_m"), "position", minimum=-1e6, maximum=1e6)
        error = sample.get("uncertainty_m")
        if error is not None:
            error = _finite_number(error, "uncertainty", minimum=0, maximum=1e6)
        rows.append((stamp, position, error))
    rows.sort(key=lambda row: row[0])
    if len({row[0] for row in rows}) != len(rows):
        raise GISValidationError("Transect dates must be unique")
    times = np.array([(row[0] - rows[0][0]).days / 365.2425 for row in rows])
    positions = np.array([row[1] for row in rows])
    regression = linregress(times, positions)
    nsm = float(positions[-1] - positions[0])
    ci = None
    if len(rows) >= 3:
        half = float(student_t.ppf(0.975, len(rows) - 2) * regression.stderr)
        ci = [float(regression.slope - half), float(regression.slope + half)]
    uncertainty = None
    if rows[0][2] is not None and rows[-1][2] is not None:
        uncertainty = math.hypot(rows[0][2], rows[-1][2])
    return {"nsm_m": nsm, "epr_m_per_year": nsm / float(times[-1]),
            "lrr_m_per_year": float(regression.slope), "lrr_95_ci_m_per_year": ci,
            "nsm_propagated_uncertainty_m": uncertainty,
            "epr_propagated_uncertainty_m_per_year": uncertainty / float(times[-1]) if uncertainty is not None else None,
            "lrr_r_squared": float(regression.rvalue ** 2) if np.ptp(positions) else None,
            "n": len(rows), "years": float(times[-1]), "sign_convention": "Positive follows the supplied transect coordinate direction",
            "formula": {"nsm": "x_last − x_first", "epr": "NSM / Δt", "lrr": "Σ((t−t̄)(x−x̄)) / Σ((t−t̄)²)",
                        "lrr_ci": "slope ± t(0.975, n−2) × SE(slope)"},
            "limitations": ["Positions must refer to the same bank/shoreline and a fixed, consistently oriented transect.",
                            "LRR interval assumes independent homoscedastic residuals and does not include systematic geolocation error.",
                            "Endpoint uncertainty is root-sum-square propagation assuming independent supplied positional errors; it is not labelled a 95% interval.",
                            "These shoreline-change rates do not predict flood extent."]}


def _array(values, label):
    try:
        result = np.asarray(values, dtype=float)
    except (ValueError, TypeError, OverflowError) as exc:
        raise GISValidationError(f"{label} must be a rectangular numeric array") from exc
    if result.ndim != 2 or not result.size or result.size > MAX_ARRAY_CELLS:
        raise GISValidationError(f"{label} must be a nonempty 2D array of at most {MAX_ARRAY_CELLS} cells")
    return result


def _mask(values, shape_, label):
    array = np.asarray(values)
    if array.shape != shape_ or array.dtype.kind != "b":
        raise GISValidationError(f"{label} must be a boolean array matching the input shape")
    return array


def _valid_arrays(first, second, valid_mask, first_name, second_name):
    a, b = _array(first, first_name), _array(second, second_name)
    if a.shape != b.shape:
        raise GISValidationError("Raster arrays must have identical shapes and prealigned grids")
    mask = _mask(valid_mask, a.shape, "valid_mask")
    # Explicitly masked nodata may be NaN, but valid pixels must be finite.
    if np.any(mask & (~np.isfinite(a) | ~np.isfinite(b))):
        raise GISValidationError("Unmasked pixels must contain finite numeric values")
    if not np.any(mask):
        raise GISValidationError("No valid pixels remain")
    return a, b, mask


def water_index_mask(band_a, band_b, valid_mask, *, index="NDWI", cloud_mask=None,
                     threshold=None, pixel_area_m2=None) -> dict:
    """Normalized-difference water mask on already aligned surface reflectance.

    NDWI: a=green, b=NIR. MNDWI: a=green, b=SWIR. All cloud/shadow/nodata
    screening is supplied by the caller; Sentinel-2 SCL must be decoded upstream.
    """
    if index not in {"NDWI", "MNDWI"}:
        raise GISValidationError("Supported water indices are NDWI and MNDWI")
    a, b, valid = _valid_arrays(band_a, band_b, valid_mask, "band_a", "band_b")
    valid = valid.copy()
    if cloud_mask is not None:
        valid &= ~_mask(cloud_mask, a.shape, "cloud_mask")
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        denominator = a + b
        values = (a - b) / denominator
    valid &= np.abs(denominator) > 1e-12
    valid &= np.isfinite(values)
    if not np.any(valid):
        raise GISValidationError("No valid noncloud pixels with a nonzero index denominator remain")
    selected = values[valid]
    # The histogram uses [-1,1], requiring physically consistent nonnegative inputs.
    if np.any(a[valid] < 0) or np.any(b[valid] < 0):
        raise GISValidationError("Water-index inputs must be nonnegative scaled reflectance")
    method = "user-selected threshold"
    if threshold is None:
        if float(np.ptp(selected)) < 1e-12:
            raise GISValidationError("Otsu needs varying valid index values; supply a justified threshold for a uniform raster")
        histogram, edges = np.histogram(selected, bins=256, range=(-1, 1))
        centers = (edges[:-1] + edges[1:]) / 2
        weights = histogram.astype(float) / histogram.sum()
        omega = np.cumsum(weights)
        means = np.cumsum(weights * centers)
        denominator_between = omega * (1 - omega)
        variance = np.full(256, -np.inf)
        legal = denominator_between > 0
        variance[legal] = (means[-1] * omega[legal] - means[legal]) ** 2 / denominator_between[legal]
        if not np.any(legal):
            raise GISValidationError("Otsu cannot separate the occupied histogram bins; supply a justified threshold")
        threshold = float(edges[int(np.argmax(variance)) + 1])
        method = "Otsu maximum between-class variance, 256 fixed bins over [-1,1]"
    else:
        threshold = _finite_number(threshold, "threshold", minimum=-1, maximum=1)
    water = valid & (values > threshold)
    area = None
    if pixel_area_m2 is not None:
        pixel_area_m2 = _finite_number(pixel_area_m2, "pixel area", minimum=1e-9, maximum=1e8)
        area = int(np.sum(water)) * pixel_area_m2
    return {"index": index, "threshold": threshold, "threshold_method": method,
            "formula": "(green − NIR) / (green + NIR)" if index == "NDWI" else "(green − SWIR) / (green + SWIR)",
            "index_values": [[float(values[r, c]) if valid[r, c] else None for c in range(a.shape[1])] for r in range(a.shape[0])],
            "water_mask": water.tolist(), "valid_mask": valid.tolist(), "valid_pixel_count": int(np.sum(valid)),
            "water_pixel_count": int(np.sum(water)), "water_area_m2": area, "confidence": None,
            "limitations": ["Requires prealigned, correctly scaled surface-reflectance bands and explicit cloud/shadow/nodata masks.",
                            "Otsu separates spectral classes; it does not estimate classification accuracy or water probability.",
                            "Terrain/building shadows, turbidity, vegetation and mixed pixels require independent validation."]}


def depth_volume(bed_elevation_m, water_surface_elevation_m, valid_mask, *, pixel_area_m2,
                 bed_vertical_datum: str, water_vertical_datum: str, connected_mask=None) -> dict:
    """Integrate max(WSE-bed,0) only on caller-declared valid (optionally connected) cells."""
    if not isinstance(bed_vertical_datum, str) or not bed_vertical_datum.strip() or bed_vertical_datum != water_vertical_datum:
        raise GISValidationError("Bed and water elevations must declare the same nonempty vertical datum")
    bed = _array(bed_elevation_m, "bed elevation")
    if isinstance(water_surface_elevation_m, (int, float, np.number)):
        wse = np.full(bed.shape, _finite_number(water_surface_elevation_m, "water surface elevation"))
    else:
        wse = water_surface_elevation_m
    bed, wse, valid = _valid_arrays(bed, wse, valid_mask, "bed elevation", "water surface elevation")
    pixel_area = _finite_number(pixel_area_m2, "pixel area", minimum=1e-9, maximum=1e8)
    if connected_mask is not None:
        valid = valid & _mask(connected_mask, bed.shape, "connected_mask")
    depths = np.maximum(wse[valid] - bed[valid], 0)
    if not np.all(np.isfinite(depths)):
        raise GISValidationError("Elevation differences overflowed; check elevation units")
    return {"volume_m3": float(np.sum(depths) * pixel_area), "wet_area_m2": int(np.sum(depths > 0)) * pixel_area,
            "evaluated_area_m2": int(np.sum(valid)) * pixel_area, "vertical_datum": bed_vertical_datum,
            "formula": "dᵢ = max(WSEᵢ − z_bed,ᵢ, 0); V = Σ dᵢ Aᵢ", "method": "Cellwise depth integration over the supplied valid domain",
            "connected_mask_supplied": connected_mask is not None, "uncertainty": None,
            "limitations": ["A terrain DEM does not generally measure underwater riverbed elevation; surveyed bathymetry is required for channel volume.",
                            "A constant water level over terrain is a static scenario, not a dynamic flood forecast.",
                            "Hydraulic connectivity must be established externally; no connectivity is inferred by this integrator.",
                            "Numeric volume has no confidence interval without validated elevation, depth and domain errors."]}


def cross_section_volume(chainages_m, areas_m2) -> dict:
    """Average-end-area (trapezoidal) integration of measured wet cross sections."""
    if not isinstance(chainages_m, (list, tuple)) or not isinstance(areas_m2, (list, tuple)) or len(chainages_m) != len(areas_m2) or not 2 <= len(chainages_m) <= 10_000:
        raise GISValidationError("Provide 2–10,000 matching chainages and cross-section areas")
    x = [_finite_number(v, "chainage", minimum=0, maximum=1e7) for v in chainages_m]
    area = [_finite_number(v, "cross-section area", minimum=0, maximum=1e9) for v in areas_m2]
    if any(b <= a for a, b in zip(x, x[1:])):
        raise GISValidationError("Cross-section chainages must be strictly increasing")
    segments = [(area[i] + area[i + 1]) * 0.5 * (x[i + 1] - x[i]) for i in range(len(x) - 1)]
    return {"volume_m3": sum(segments), "segment_volumes_m3": segments, "formula": "V = Σ ((Aᵢ + Aᵢ₊₁)/2) × (xᵢ₊₁ − xᵢ)",
            "method": "Average-end-area method", "uncertainty": None,
            "limitations": ["Measured areas must describe comparable wet cross sections at one water-level scenario.",
                            "Linear area variation between sections is assumed; sparse sections can miss channel geometry."]}


def dem_difference_volume(before_m, after_m, valid_mask, *, pixel_area_m2,
                          before_vertical_datum: str, after_vertical_datum: str,
                          rmse_before_m: float, rmse_after_m: float, z_score: float = 1.96) -> dict:
    """Coregistered DEM-of-difference volume with a uniform independent-error LoD."""
    if not isinstance(before_vertical_datum, str) or not before_vertical_datum.strip() or before_vertical_datum != after_vertical_datum:
        raise GISValidationError("Both DEMs must declare the same nonempty vertical datum")
    before, after, valid = _valid_arrays(before_m, after_m, valid_mask, "before DEM", "after DEM")
    pixel_area = _finite_number(pixel_area_m2, "pixel area", minimum=1e-9, maximum=1e8)
    before_error = _finite_number(rmse_before_m, "before vertical error", minimum=0, maximum=1e5)
    after_error = _finite_number(rmse_after_m, "after vertical error", minimum=0, maximum=1e5)
    z = _finite_number(z_score, "z score", minimum=0.01, maximum=10)
    lod = z * math.hypot(before_error, after_error)
    differences = after[valid] - before[valid]
    if not np.all(np.isfinite(differences)):
        raise GISValidationError("Elevation differences overflowed; check elevation units")
    retained = differences[np.abs(differences) > lod]
    deposition = float(np.sum(retained[retained > 0]) * pixel_area)
    erosion = float(-np.sum(retained[retained < 0]) * pixel_area)
    return {"deposition_volume_m3": deposition, "erosion_volume_m3": erosion, "net_volume_m3": deposition - erosion,
            "raw_net_volume_m3": float(np.sum(differences) * pixel_area), "level_of_detection_m": lod,
            "retained_cell_count": int(retained.size), "valid_cell_count": int(differences.size),
            "vertical_datum": before_vertical_datum, "formula": "Δz = z_after − z_before; LoD = k√(σ_before² + σ_after²); V = Σ(Δz A), |Δz| > LoD",
            "uncertainty": None, "limitations": ["DEMs must already share horizontal grid, vertical datum and coregistration.",
                "Uniform LoD assumes independent approximately Gaussian elevation errors, with input RMSE treated as standard deviation and negligible bias.",
                "Spatially correlated errors are not represented; this is not an integrated-volume confidence interval.",
                "Topographic change volume is not water-storage volume; submerged areas require bathymetric measurements."]}

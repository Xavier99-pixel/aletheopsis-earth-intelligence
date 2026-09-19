import json
import math

import numpy as np
import pytest
from pyproj import Transformer
from shapely.geometry import LineString, box, mapping
from shapely.ops import transform

from app.gis_engine import (GISValidationError, analyse_river, cross_section_volume, dem_difference_volume,
                            depth_volume, project_local, shoreline_rates, validate_wgs84_geometry, water_index_mask)

BACK = Transformer.from_crs(32644, 4326, always_xy=True).transform
X, Y = 460000, 1820000


def geo(geometry):
    return json.loads(json.dumps(mapping(transform(BACK, geometry))))


def observation(geometry, day="2020-01-01", **kwargs):
    return {"date": day, "geometry": geo(geometry), "source": "Survey fixture", "scene_ids": [], **kwargs}


def metric(result, prefix):
    return next(row["value"] for row in result["metrics"] if row["id"].startswith(prefix))


def test_area_edges_width_and_projection_are_measured_not_hardcoded():
    aoi = geo(box(X,Y,X+1000,Y+1000))
    water = box(X-100,Y+400,X+1100,Y+600)
    result = analyse_river([observation(water)], aoi, [100], geo(LineString([(X-100,Y+500),(X+1100,Y+500)])), 100)
    assert result["provenance"]["calculation_crs"] == "EPSG:32644"
    assert metric(result,"water_area") == pytest.approx(200000, abs=1)
    assert metric(result,"water_edge_length") == pytest.approx(2000, abs=2)
    assert metric(result,"mean_wetted_width") == pytest.approx(200, abs=.1)
    assert metric(result,"supplied_centerline_length") == pytest.approx(1000, abs=.1)
    assert metric(result,"channel_volume") is None
    assert metric(result,"flood_inundation_area") is None
    assert 199000 < metric(result,"proximity_area") < 201000
    json.dumps(result, allow_nan=False)


def test_temporal_overlay_and_cloud_coverage_do_not_create_false_change():
    aoi = geo(box(X,Y,X+1000,Y+1000))
    water = box(X,Y+400,X+1000,Y+600)
    clipped = water.intersection(box(X,Y,X+500,Y+1000))
    first = observation(water, valid_geometry=aoi)
    second = observation(clipped,"2021-01-01",valid_geometry=geo(box(X,Y,X+500,Y+1000)))
    result = analyse_river([first,second], aoi, [])
    assert metric(result,"change_net") == pytest.approx(0, abs=.1)
    assert metric(result,"change_lost") == pytest.approx(0, abs=.1)
    # Missing coverage edges cannot be called observed river edges.
    lengths = [m["value"] for m in result["metrics"] if m["id"].startswith("water_edge")]
    assert lengths[1] == pytest.approx(1000,abs=2)


def test_gained_lost_sample_evidence_and_order():
    aoi = geo(box(X,Y,X+1000,Y+1000))
    a = observation(box(X,Y+400,X+1000,Y+600),is_sample=True)
    b = observation(box(X,Y+400,X+1000,Y+650),"2021-01-01")
    result = analyse_river([b,a], aoi,[500])
    assert metric(result,"change_gained") == pytest.approx(50000,abs=1)
    assert metric(result,"change_lost") == pytest.approx(0,abs=.1)
    assert all(row["evidence_level"] == "EXAMPLE" for row in result["metrics"])
    assert result["temporal"][0]["date"] == "2020-01-01"


@pytest.mark.parametrize("bad", [float("nan"),float("inf"),True,"80"])
def test_invalid_coordinates_rejected(bad):
    with pytest.raises(GISValidationError):
        validate_wgs84_geometry({"type":"Polygon","coordinates":[[[bad,16],[81,16],[81,17],[bad,16]]]})


def test_world_crs_and_reversed_observation_inputs_rejected():
    with pytest.raises(GISValidationError): project_local(mapping(box(-170,-50,170,70)))
    with pytest.raises(GISValidationError): validate_wgs84_geometry({**geo(box(X,Y,X+100,Y+100)),"crs":"EPSG:3857"})
    with pytest.raises(GISValidationError): analyse_river([observation(box(X,Y,X+100,Y+100))]*2, geo(box(X,Y,X+1000,Y+1000)), [])
    with pytest.raises(GISValidationError): analyse_river([observation(box(X,Y,X+100,Y+100))], geo(box(X,Y,X+1000,Y+1000)), [float("nan")])


def test_water_indices_preserve_masks_and_zero_denominators():
    result = water_index_mask([[.3,.1],[0,.9]], [[.1,.3],[0,.1]], [[True,True],[True,False]],threshold=0,pixel_area_m2=400)
    assert result["index_values"][0] == pytest.approx([.5,-.5])
    assert result["valid_pixel_count"] == 2
    assert result["water_pixel_count"] == 1
    assert result["water_area_m2"] == 400
    assert result["confidence"] is None
    with pytest.raises(GISValidationError): water_index_mask([[1]],[[1]],[[False]])
    with pytest.raises(GISValidationError): water_index_mask([[1]],[[1]],[[True]])


def test_otsu_separates_known_bimodal_values():
    result = water_index_mask([[.4,.45,.05,.04]],[[.1,.1,.4,.5]],[[True]*4])
    assert result["water_mask"] == [[True,True,False,False]]
    assert -1 <= result["threshold"] <= 1


def test_known_volume_and_vertical_datum_checks():
    assert cross_section_volume([0,100,200],[20,30,40])["volume_m3"] == 6000
    result = depth_volume([[2,3],[4,6]],5,[[True,True],[True,True]],pixel_area_m2=100,bed_vertical_datum="MSL",water_vertical_datum="MSL")
    assert result["volume_m3"] == 600
    with pytest.raises(GISValidationError): depth_volume([[2]],5,[[True]],pixel_area_m2=100,bed_vertical_datum="MSL",water_vertical_datum="ellipsoid")
    with pytest.raises(GISValidationError): cross_section_volume([100,0],[20,30])


def test_dem_difference_excludes_sub_lod_change():
    result = dem_difference_volume([[0,0,0]],[[1,.1,-1]],[[True]*3],pixel_area_m2=100,before_vertical_datum="MSL",after_vertical_datum="MSL",rmse_before_m=.1,rmse_after_m=.1)
    assert result["deposition_volume_m3"] == 100
    assert result["erosion_volume_m3"] == 100
    assert result["net_volume_m3"] == 0
    assert result["retained_cell_count"] == 2


def test_transect_rates_known_endpoints():
    samples = [{"date":"2020-01-01","position_m":10,"uncertainty_m":3}, {"date":"2021-01-01","position_m":20,"uncertainty_m":4}]
    result = shoreline_rates(samples)
    assert result["nsm_m"] == 10
    assert result["epr_m_per_year"] == pytest.approx(10*365.2425/366)
    assert result["nsm_propagated_uncertainty_m"] == 5
    assert result["lrr_95_ci_m_per_year"] is None

import io
import json
import tarfile

import numpy as np
import pytest
from pyproj import Transformer
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

from app.satellite import process_raster, unpack_response


def raster_fixture(cloudy=False):
    bands = np.zeros((6,32,32),dtype="float32")
    bands[0] = .1; bands[1] = .4; bands[2] = .4
    bands[0,8:24,8:24] = .4; bands[1:3,8:24,8:24] = .1
    bands[3] = 9 if cloudy else 4; bands[4] = 1; bands[5] = 1
    affine = from_origin(460000,1820000,20,20)
    with MemoryFile() as memory:
        with memory.open(driver="GTiff",height=32,width=32,count=6,dtype="float32",crs="EPSG:32644",transform=affine) as dataset:
            dataset.write(bands)
        raw = memory.read()
    backward = Transformer.from_crs(32644,4326,always_xy=True).transform
    aoi = json.loads(json.dumps(mapping(transform(backward,box(460000,1819360,460640,1820000)))))
    metadata = {"tiles":[{"shId":123,"date":"2020-01-01T05:00:00Z","dataPath":"test://fixture-only"}]}
    return raw, metadata, aoi


def test_real_raster_pipeline_calculates_pixels_mask_area_and_provenance():
    raw, metadata, aoi = raster_fixture()
    water, valid, details, mask_bytes = process_raster(raw,metadata,aoi,None)
    assert details["selected_water_pixel_count"] == 256
    assert details["raster_water_area_m2"] == 102400
    assert details["valid_coverage_fraction"] == 1
    assert details["classification_accuracy"] is None
    assert details["sar_validation"] == "not_run"
    assert details["ndwi_agreement_with_selected_water"] == 1
    assert len(details["used_tiles"]) == 1
    assert shape(water).area > 0 and shape(valid).covers(shape(water))
    with MemoryFile(mask_bytes) as memory, memory.open() as dataset:
        assert dataset.nodata == 255
        assert np.sum(dataset.read(1)==1) == 256


def test_clouds_and_missing_source_metadata_are_not_zero_water():
    raw, metadata, aoi = raster_fixture(cloudy=True)
    with pytest.raises(ValueError, match="clear pixels"): process_raster(raw,metadata,aoi,None)
    raw, _, aoi = raster_fixture()
    with pytest.raises(ValueError, match="source indices"): process_raster(raw,{"tiles":[]},aoi,None)


def test_seed_must_be_inside_detected_water():
    raw, metadata, aoi = raster_fixture()
    backward = Transformer.from_crs(32644,4326,always_xy=True).transform
    with pytest.raises(ValueError, match="seed"): process_raster(raw,metadata,aoi,list(backward(460020,1819980)))


def test_tar_is_read_without_extracting_provider_paths(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf,mode="w") as archive:
        for name,content in [("default.tif",b"fixture"),("userdata.json",b'{"tiles": []}'),("../../unexpected",b"do-not-extract")]:
            member = tarfile.TarInfo(name); member.size=len(content); archive.addfile(member,io.BytesIO(content))
    raw, metadata = unpack_response(buf.getvalue())
    assert raw == b"fixture" and metadata == {"tiles":[]}
    assert list(tmp_path.iterdir()) == []

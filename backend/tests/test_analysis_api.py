import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import analysis, analysis_store, scientific_tools


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ANALYSIS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("INTELLIGENCE_ALLOW_UNAUTHENTICATED", raising=False)
    analysis.limiter._events.clear()
    with TestClient(app) as client:
        yield client


def request_data():
    return {"question":"Analyse Krishna water extent and 2 km screening",
            "aoi":{"name":"Krishna River · Vijayawada","bbox":[80.54,16.43,80.69,16.55],"source":"preset"},
            "start_date":"2018-10-01","end_date":"2024-10-01","source_mode":"sample","buffer_m":2000}


def test_sample_is_real_math_clearly_labelled_and_cached(client):
    data = request_data()
    response = client.post("/api/analysis/river", json=data)
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    run = client.get(f"/api/analysis/{run_id}").json()
    assert run["status"] == "COMPLETE", run
    assert "owner" not in run and "cache_key" not in run
    result = run["result"]
    assert result["provenance"]["calculation_crs"] == "EPSG:32644"
    assert result["source_mode"] == "sample"
    assert len(result["layers"]) >= 5
    assert all(item["evidence_level"] == "EXAMPLE" for item in result["metrics"])
    assert all(item["value"] is None for item in result["metrics"] if item["id"] in {"channel_volume","flood_inundation_area"})
    assert client.get(f"/api/analysis/{run_id}/calculations").status_code == 200
    assert client.get(f"/api/analysis/{run_id}/provenance").status_code == 200
    assert client.get(f"/api/analysis/{run_id}/report").status_code == 200
    again = client.post("/api/analysis/river", json=data).json()
    assert again["cached"] is True and again["id"] == run_id


def test_actual_source_requires_auth_and_cannot_use_chat_bypass(client, monkeypatch):
    data = request_data(); data["source_mode"] = "satellite"
    assert client.post("/api/analysis/river", json=data).status_code == 401
    monkeypatch.setenv("INTELLIGENCE_ALLOW_UNAUTHENTICATED","true")
    assert client.post("/api/analysis/river", json=data).status_code == 503


def test_private_runs_and_assets_are_owner_scoped(client, monkeypatch):
    run_id = "72906623-e286-4c64-9f5a-eb229c5ab060"
    analysis_store.create_run(run_id,"owner-a","test",{})
    analysis_store.update_run(run_id,"COMPLETE",result={"secret":"private geometry"})
    async def owner_b(_): return "owner-b"
    monkeypatch.setattr(analysis,"subject",owner_b)
    assert client.get(f"/api/analysis/{run_id}").status_code == 404
    assert client.get(f"/api/analysis/{run_id}/assets/A-source.tif").status_code == 404
    async def owner_a(_): return "owner-a"
    monkeypatch.setattr(analysis,"subject",owner_a)
    assert client.get(f"/api/analysis/{run_id}").json()["result"]["secret"] == "private geometry"


def test_dates_coordinates_and_request_size_are_checked(client):
    data = request_data(); data["start_date"] = data["end_date"]
    assert client.post("/api/analysis/river",json=data).status_code == 422
    data = request_data(); data["aoi"]["bbox"] = [-170,-70,170,70]
    assert client.post("/api/analysis/river",json=data).status_code == 422
    response = client.post("/api/analysis/river",content=b"x"*2_000_001,headers={"Content-Type":"application/json"})
    assert response.status_code == 413


def test_failed_interrupted_job_is_not_mistaken_for_complete(client):
    analysis_store.create_run("pending","owner","key",{})
    analysis_store.recover_interrupted()
    run = analysis_store.get_run("pending")
    assert run["status"] == "FAILED" and run["result"] is None


def test_volume_tool_and_real_data_auth_boundary(client):
    body = {"operation":"cross_section_volume","source":"Teaching fixture","is_sample":True,
            "parameters":{"chainages_m":[0,100,200],"areas_m2":[20,30,40]}}
    response = client.post("/api/gis/calculate",json=body)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["volume_m3"] == 6000
    assert response.json()["evidence_level"] == "EXAMPLE"
    body["is_sample"] = False
    assert client.post("/api/gis/calculate",json=body).status_code == 401
    body["is_sample"] = True; body["parameters"]["unexpected"] = 42
    assert client.post("/api/gis/calculate",json=body).status_code == 422


def test_government_routes_cannot_be_unlocked_by_chat_dev_mode(client,monkeypatch):
    monkeypatch.setenv("INTELLIGENCE_ALLOW_UNAUTHENTICATED","true")
    assert client.get("/api/land/session").status_code == 401
    assert client.get("/api/land/parcels").status_code == 401
    assert client.get("/api/health").status_code == 200

"""Integration test: POSTGIS_TEST_URL must name an empty, disposable test database."""
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.land import Official, verified_official

TEST_URL = os.getenv("POSTGIS_TEST_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="A disposable PostGIS test database is not configured")


def test_postgis_import_monitor_validity_and_department_isolation(tmp_path,monkeypatch):
    import psycopg
    # This optional test only writes the explicit disposable test database.
    with psycopg.connect(TEST_URL) as connection:
        connection.execute(Path("backend/app/db/migrations/002_land_monitor.sql").read_text())
    monkeypatch.setenv("DATABASE_URL",TEST_URL)
    monkeypatch.setenv("ANALYSIS_DATA_DIR",str(tmp_path))
    official = Official("test-admin-a","test-department-a","government_admin")
    app.dependency_overrides[verified_official] = lambda: official
    source = {"name":"Integration fixture only","record_id":"TEST-ONLY","retrieved_at":"2024-01-01","license":"Synthetic test data"}
    geometry = {"type":"Polygon","coordinates":[[[80.60,16.50],[80.601,16.50],[80.601,16.501],[80.60,16.501],[80.60,16.50]]]}
    try:
        with TestClient(app) as client:
            response = client.post("/api/land/parcels",json={"parcels":[{
                "parcel_reference":"TEST-A-001","survey_number":"TEST-001","district":"Test district",
                "ownership_type":"government","geometry":geometry,"valid_from":"2018-01-01","source":source}]})
            assert response.status_code == 201,response.text
            parcel_id=response.json()["parcel_ids"][0]
            response=client.post("/api/land/authorizations",json={"parcel_id":parcel_id,"authorization_reference":"TEST-AUTH-001",
                "authorization_type":"test_permission","authorized_use":"test_use","status":"authorized","geometry":geometry,
                "valid_from":"2020-01-01","valid_to":"2023-12-31","issuing_department":"Test department","document_reference":"TEST-DOC","source":source})
            assert response.status_code == 201,response.text
            query={"bankline":{"type":"LineString","coordinates":[[80.6005,16.499],[80.6005,16.502]]},
                "bankline_source":source,"bankline_date":"2020-01-01","distance_m":500,"as_of":"2023-12-31"}
            response=client.post("/api/land/monitor",json=query)
            assert response.status_code == 200,response.text
            parcel=response.json()["parcels"][0]
            assert parcel["distance_to_bank_m"] == 0
            assert parcel["authorized_coverage_pct"] == pytest.approx(100)
            assert parcel["legal_status"] == "authorized_on_record"
            assert parcel["observation_status"] == "not_assessed"
            query["as_of"]="2024-01-01"
            assert client.post("/api/land/monitor",json=query).json()["parcels"][0]["legal_status"] == "requires_officer_verification"
            official=Official("test-admin-b","test-department-b","government_admin")
            assert client.get("/api/land/parcels").json()["parcels"] == []
            assert client.post("/api/land/monitor",json=query).json()["parcels"] == []
    finally:
        app.dependency_overrides.pop(verified_official,None)

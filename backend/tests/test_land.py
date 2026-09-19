from datetime import date

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.land import (Geometry, MonitorInput, Official, Validity, authorization_status, official_from_user,
                      record_active, require_role, MONITOR_SQL)


def test_user_selected_role_is_not_government_access():
    with pytest.raises(HTTPException) as err:
        official_from_user({"id":"officer","user_metadata":{"department_id":"revenue-ap","government_role":"super_admin"}})
    assert err.value.status_code == 403
    official = official_from_user({"id":"officer","app_metadata":{"department_id":"revenue-ap","government_role":"revenue_officer"}})
    assert official.department_id == "revenue-ap"
    with pytest.raises(HTTPException): require_role(official)
    require_role(Official("admin","revenue-ap","government_admin"))


def test_missing_conflicting_and_explicit_records():
    assert authorization_status([]) == "requires_officer_verification"
    assert authorization_status([{"status":"authorized"}]) == "authorized_on_record"
    assert authorization_status([{"status":"unauthorized"}]) == "unauthorized_on_record"
    assert authorization_status([{"status":"authorized"},{"status":"revoked"}]) == "conflicting_records_requires_verification"


def test_record_validity_inclusive_and_expiry():
    record = {"valid_from":date(2020,1,1),"valid_to":date(2020,12,31)}
    assert record_active(record,date(2020,1,1))
    assert record_active(record,date(2020,12,31))
    assert not record_active(record,date(2021,1,1))
    with pytest.raises(ValidationError): Validity(valid_from="2021-01-01",valid_to="2020-01-01")


def test_geometry_rejects_nonfinite_and_unclosed_ring():
    with pytest.raises(ValidationError): Geometry(type="LineString",coordinates=[[float("nan"),16],[80,16]])
    with pytest.raises(ValidationError): Geometry(type="Polygon",coordinates=[[[80,16],[81,16],[81,17],[80,17]]])


def test_monitor_queries_scope_every_sensitive_table():
    # Regression guard complements optional PostGIS integration checks.
    assert "p.department_id=%(department)s" in MONITOR_SQL
    assert "a.department_id=%(department)s" in MONITOR_SQL
    assert "o.department_id=%(department)s" in MONITOR_SQL
    assert "a.valid_from <= %(as_of)s" in MONITOR_SQL
    assert "ST_DWithin" in MONITOR_SQL and "::geography" in MONITOR_SQL

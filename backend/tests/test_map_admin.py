import asyncio
import json
import httpx
import pytest
from shapely.geometry import shape, mapping, box
from pydantic import ValidationError
from app.analysis import AOI, RiverRequest
from app.gis_engine import analyse_river
from app import admin_bootstrap

TRIANGLE = {"type":"Polygon","coordinates":[[[80.6,16.5],[80.62,16.5],[80.6,16.52],[80.6,16.5]]]}

def test_polygon_validation_and_seed():
    aoi = AOI(name="Triangle",bbox=[80.6,16.5,80.62,16.52],geometry=TRIANGLE)
    with pytest.raises(ValidationError, match="inside"):
        RiverRequest(aoi=aoi,start_date="2020-01-01",end_date="2021-01-01",source_mode="sample",water_seed=[80.619,16.519])
    with pytest.raises(ValidationError, match="bounds"):
        AOI(name="Wrong bounds",bbox=[80.59,16.5,80.62,16.52],geometry=TRIANGLE)
    with pytest.raises(ValueError):
        AOI(name="Crossing",bbox=[80.6,16.5,80.62,16.52],geometry={"type":"Polygon","coordinates":[[[80.6,16.5],[80.62,16.52],[80.6,16.52],[80.62,16.5],[80.6,16.5]]]})

def test_exact_polygon_area_is_not_bounding_rectangle():
    observations=[{"date":date,"geometry":mapping(box(80.59,16.49,80.63,16.53)),"source":"synthetic coverage","resolution_m":10} for date in ["2020-01-01","2021-01-01"]]
    triangle=analyse_river(observations,TRIANGLE,[500])
    rectangle=analyse_river(observations,mapping(box(*shape(TRIANGLE).bounds)),[500])
    a=next(m['value'] for m in triangle['calculations'] if m['unit']=='m²' and m['value'])
    b=next(m['value'] for m in rectangle['calculations'] if m['unit']=='m²' and m['value'])
    assert .49 < a/b < .51

def configure(monkeypatch):
    for k,v in {"BOOTSTRAP_ADMIN_ENABLED":"true","SUPABASE_URL":"https://project.supabase.co","SUPABASE_SERVICE_ROLE_KEY":"server-test-key","BOOTSTRAP_ADMIN_EMAIL":"admin@example.org","BOOTSTRAP_ADMIN_DEPARTMENT_ID":"land-revenue","BOOTSTRAP_ADMIN_PASSWORD":"long-test-password-only","BOOTSTRAP_ADMIN_EMAIL_VERIFIED":"true","BOOTSTRAP_ADMIN_USER_ID":""}.items(): monkeypatch.setenv(k,v)

def mock_client(monkeypatch, handler):
    original=httpx.AsyncClient
    monkeypatch.setattr(admin_bootstrap.httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))

def test_bootstrap_disabled_and_requires_verified_email(monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_ADMIN_ENABLED",raising=False)
    assert asyncio.run(admin_bootstrap.provision_admin())=="disabled"
    configure(monkeypatch);monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL_VERIFIED","false")
    with pytest.raises(ValueError,match="verified"): asyncio.run(admin_bootstrap.provision_admin())

def test_new_admin_has_server_managed_role(monkeypatch):
    configure(monkeypatch)
    def handler(request):
        body=json.loads(request.content)
        assert request.method=="POST" and str(request.url).endswith("/auth/v1/admin/users")
        assert body['app_metadata']=={"department_id":"land-revenue","government_role":"government_admin"}
        assert body['email_confirm'] is True
        return httpx.Response(201,json={"id":"new-admin"})
    mock_client(monkeypatch,handler)
    assert asyncio.run(admin_bootstrap.provision_admin())=="provisioned"

def test_existing_admin_preserves_metadata_and_password(monkeypatch):
    configure(monkeypatch);monkeypatch.setenv("BOOTSTRAP_ADMIN_USER_ID","11111111-1111-4111-8111-111111111111")
    def handler(request):
        if request.method=="GET": return httpx.Response(200,json={"email":"admin@example.org","app_metadata":{"provider":"email"}})
        body=json.loads(request.content)
        assert request.method=="PUT" and 'password' not in body
        assert body['app_metadata']['provider']=='email'
        return httpx.Response(200,json={})
    mock_client(monkeypatch,handler)
    assert asyncio.run(admin_bootstrap.provision_admin())=="provisioned"

def test_existing_admin_id_must_match_email(monkeypatch):
    configure(monkeypatch);monkeypatch.setenv("BOOTSTRAP_ADMIN_USER_ID","11111111-1111-4111-8111-111111111111")
    mock_client(monkeypatch,lambda request:httpx.Response(200,json={"email":"someoneelse@example.org"}))
    with pytest.raises(ValueError,match="match"): asyncio.run(admin_bootstrap.provision_admin())

"""Department-scoped land records and auditable bank-distance screening.

Imagery observations flag potential unregistered use; they never establish title
or legality. Only provisioned Supabase app_metadata grants government access.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
import json
import math
import os
import re
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.concurrency import run_in_threadpool

ROLES = frozenset({'super_admin', 'government_admin', 'revenue_officer', 'urban_planner',
                   'environment_officer', 'disaster_manager', 'researcher', 'viewer'})
EDIT_ROLES = frozenset({'super_admin', 'government_admin'})
OBSERVATION_ROLES = EDIT_ROLES | {'revenue_officer'}
MAX_BODY_BYTES = 2_000_000
MAX_VERTICES = 10_000


class BoundedLandRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            if request.method == 'POST':
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BODY_BYTES:
                        raise HTTPException(413, 'Land request exceeds the 2 MB limit; split the dataset into batches.')
                    chunks.append(chunk)
                request._body = b''.join(chunks)
            return await handler(request)
        return bounded


router = APIRouter(prefix='/api/land', tags=['Government land'], route_class=BoundedLandRoute)


@dataclass(frozen=True)
class Official:
    user_id: str
    department_id: str
    role: str


def official_from_user(payload: dict) -> Official:
    metadata = payload.get('app_metadata') or {}
    if not isinstance(metadata, dict):
        raise HTTPException(403, 'A government administrator must provision this account.')
    department = metadata.get('department_id')
    role = metadata.get('government_role')
    user_id = payload.get('id')
    if (not isinstance(user_id, str) or not user_id or len(user_id) > 128
            or not isinstance(department, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', department)
            or not isinstance(role, str) or role not in ROLES):
        raise HTTPException(403, 'Government access requires administrator-managed department_id and government_role in Supabase app_metadata.')
    return Official(user_id, department, role)


async def verified_official(authorization: str | None = Header(default=None)) -> Official:
    scheme, _, token = (authorization or '').partition(' ')
    if scheme.lower() != 'bearer' or not (20 <= len(token.strip()) <= 8192):
        raise HTTPException(401, 'Sign in with an administrator-provisioned government account.')
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    key = os.getenv('SUPABASE_ANON_KEY', '')
    if not url.startswith('https://') or not key:
        raise HTTPException(503, 'Government authentication needs server-side SUPABASE_URL and SUPABASE_ANON_KEY.')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f'{url}/auth/v1/user', headers={'Authorization': f'Bearer {token.strip()}', 'apikey': key})
        if response.status_code != 200:
            if response.status_code >= 500:
                raise HTTPException(503, 'The authentication provider is unavailable. Retry later.')
            raise HTTPException(401, 'The government session is invalid or expired. Sign in again.')
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(503, 'The authentication provider is unavailable. Retry later.') from error
    if not isinstance(payload, dict):
        raise HTTPException(401, 'The authentication provider returned an invalid session.')
    return official_from_user(payload)


def require_role(official: Official, allowed=EDIT_ROLES):
    if official.role not in allowed:
        raise HTTPException(403, 'Your provisioned government role cannot import this record.')


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Source(StrictModel):
    name: str = Field(min_length=2, max_length=240)
    record_id: str = Field(min_length=1, max_length=240)
    retrieved_at: date
    license: str = Field(min_length=2, max_length=400)
    url: str | None = Field(default=None, max_length=1500)

    @field_validator('url')
    @classmethod
    def safe_source_url(cls, value):
        if value and not value.startswith(('https://', 'http://')):
            raise ValueError('source URL must use https:// or http://')
        return value


class Geometry(StrictModel):
    type: Literal['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString']
    coordinates: list[Any] = Field(min_length=1, max_length=MAX_VERTICES)

    @model_validator(mode='after')
    def coordinates_valid(self):
        points: list[list[float]] = []

        def line(coordinates, polygon=False):
            if not isinstance(coordinates, list) or len(coordinates) < (4 if polygon else 2):
                raise ValueError('Polygon rings need four positions; lines need two.')
            for position in coordinates:
                if not isinstance(position, list) or len(position) != 2:
                    raise ValueError('Use two-dimensional WGS84 longitude/latitude positions.')
                if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in position):
                    raise ValueError('All coordinates must be finite numbers.')
                if not (-180 <= position[0] <= 180 and -80 <= position[1] <= 84):
                    raise ValueError('Longitude must be -180..180 and latitude -80..84 (UTM coverage).')
                points.append(position)
                if len(points) > MAX_VERTICES:
                    raise ValueError(f'A geometry may contain at most {MAX_VERTICES} vertices.')
            if polygon and coordinates[0] != coordinates[-1]:
                raise ValueError('Polygon rings must be explicitly closed.')
            if len({tuple(p) for p in coordinates}) < (3 if polygon else 2):
                raise ValueError('Geometry must have distinct positions.')

        def polygon(rings):
            if not isinstance(rings, list) or not rings:
                raise ValueError('Polygon coordinates must contain at least one ring.')
            for ring in rings:
                line(ring, True)

        if self.type == 'LineString':
            line(self.coordinates)
        elif self.type == 'MultiLineString':
            for part in self.coordinates:
                line(part)
        elif self.type == 'Polygon':
            polygon(self.coordinates)
        else:
            for part in self.coordinates:
                polygon(part)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        if max(xs) - min(xs) > 3 or max(ys) - min(ys) > 4:
            raise ValueError('Upload a local reach/parcel within a 3° longitude by 4° latitude extent.')
        return self


def polygon_only(geometry: Geometry) -> Geometry:
    if geometry.type not in {'Polygon', 'MultiPolygon'}:
        raise ValueError('Parcel, authorization and observation footprints must be Polygon or MultiPolygon.')
    return geometry


class Validity(StrictModel):
    valid_from: date
    valid_to: date | None = None

    @model_validator(mode='after')
    def ordered_dates(self):
        if self.valid_to and self.valid_to < self.valid_from:
            raise ValueError('valid_to must be on or after valid_from (both inclusive).')
        return self


class ParcelInput(Validity):
    parcel_reference: str = Field(min_length=1, max_length=160)
    survey_number: str = Field(min_length=1, max_length=160)
    district: str = Field(min_length=1, max_length=160)
    ownership_type: Literal['government', 'private', 'other', 'unknown']
    geometry: Geometry
    source: Source
    _polygon = field_validator('geometry')(polygon_only)


class ParcelImport(StrictModel):
    parcels: list[ParcelInput] = Field(min_length=1, max_length=100)


class AuthorizationInput(Validity):
    parcel_id: UUID
    authorization_reference: str = Field(min_length=1, max_length=160)
    authorization_type: str = Field(min_length=1, max_length=160)
    authorized_use: str = Field(min_length=1, max_length=160)
    status: Literal['authorized', 'unauthorized', 'revoked']
    geometry: Geometry
    issuing_department: str = Field(min_length=1, max_length=160)
    document_reference: str = Field(min_length=1, max_length=500)
    source: Source
    _polygon = field_validator('geometry')(polygon_only)


class ObservationInput(StrictModel):
    parcel_id: UUID
    observed_at: date
    scene_id: str = Field(min_length=1, max_length=240)
    observed_use: Literal['built_up'] = 'built_up'
    geometry: Geometry
    source: Source
    analysis_run_id: str = Field(min_length=1, max_length=160)
    _polygon = field_validator('geometry')(polygon_only)

    @field_validator('observed_at')
    @classmethod
    def past_observation(cls, value):
        if value > date.today():
            raise ValueError('An observation cannot be dated in the future.')
        return value


class MonitorInput(StrictModel):
    bankline: Geometry
    bankline_source: Source
    bankline_date: date
    distance_m: float = Field(default=500, ge=1, le=10_000, allow_inf_nan=False)
    as_of: date

    @model_validator(mode='after')
    def bankline_valid(self):
        if self.bankline.type not in {'LineString', 'MultiLineString'}:
            raise ValueError('Use dated LineString/MultiLineString banklines, not a water polygon perimeter.')
        if self.bankline_date > self.as_of or self.as_of > date.today():
            raise ValueError('bankline_date must not exceed as_of; as_of must not be in the future.')
        return self


@contextmanager
def connection(official: Official):
    url = os.getenv('DATABASE_URL')
    if not url:
        raise HTTPException(503, 'Land records need DATABASE_URL and migration backend/app/db/migrations/002_land_monitor.sql. No records are simulated.')
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise HTTPException(503, 'Install psycopg[binary] and configure a PostgreSQL/PostGIS land database.') from error
    try:
        with psycopg.connect(url, row_factory=dict_row, connect_timeout=5, options='-c statement_timeout=15000') as conn:
            conn.execute("SELECT set_config('app.department_id', %s, true)", (official.department_id,))
            yield conn
    except HTTPException:
        raise
    except psycopg.errors.UndefinedTable as error:
        raise HTTPException(503, 'Land schema is missing. Apply backend/app/db/migrations/002_land_monitor.sql.') from error
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(409, 'This department already has that record reference. Existing records are not overwritten.') from error
    except (psycopg.errors.CheckViolation, psycopg.errors.InvalidParameterValue, psycopg.errors.DataException) as error:
        raise HTTPException(422, 'Database rejected an invalid geometry or record. Check polygon topology and dates.') from error
    except psycopg.Error as error:
        raise HTTPException(503, 'Land database operation failed. Check PostGIS, runtime permissions and database availability.') from error


def audit(conn, official: Official, action: str, details: dict):
    conn.execute('INSERT INTO land_audit_log(department_id,actor_id,action,details) VALUES (%s,%s,%s,%s::jsonb)',
                 (official.department_id, official.user_id, action, json.dumps(details)))


def valid_geometry(conn, geometry: Geometry):
    encoded = geometry.model_dump_json()
    row = conn.execute('SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AS valid FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s),4326) AS g) s', (encoded,)).fetchone()
    if not row or not row['valid']:
        raise HTTPException(422, 'Invalid or empty geometry. Repair its topology before import.')
    return encoded


def authorization_status(records: list[dict]) -> str:
    statuses = {r['status'] for r in records}
    if not statuses:
        return 'requires_officer_verification'
    if len(statuses) > 1:
        return 'conflicting_records_requires_verification'
    return f'{next(iter(statuses))}_on_record'


def record_active(record: dict, as_of: date) -> bool:
    """Inclusive validity mirrors the SQL predicate; open-ended records persist."""
    return record['valid_from'] <= as_of and (record.get('valid_to') is None or as_of <= record['valid_to'])


@router.get('/session')
async def session(official: Official = Depends(verified_official)):
    def run():
        with connection(official) as conn:
            audit(conn, official, 'session_verified', {})
        return {'department_id': official.department_id, 'role': official.role,
                'can_import': official.role in EDIT_ROLES, 'can_observe': official.role in OBSERVATION_ROLES}
    return await run_in_threadpool(run)


@router.get('/parcels')
async def parcels(limit: int = Query(default=100, ge=1, le=500), offset: int = Query(default=0, ge=0, le=100_000), official: Official = Depends(verified_official)):
    def run():
        with connection(official) as conn:
            rows = conn.execute('''SELECT id, parcel_reference, survey_number, district, ownership_type,
                source, valid_from, valid_to, area_epsg, ST_Area(ST_Transform(geom,area_epsg)) AS area_m2
                FROM land_parcels WHERE department_id=%s ORDER BY created_at DESC,id LIMIT %s OFFSET %s''',
                (official.department_id, limit, offset)).fetchall()
            audit(conn, official, 'parcels_viewed', {'limit': limit, 'offset': offset, 'count': len(rows)})
            return {'parcels': rows, 'limit': limit, 'offset': offset}
    return await run_in_threadpool(run)


@router.post('/parcels', status_code=201)
async def import_parcels(request: ParcelImport, official: Official = Depends(verified_official)):
    require_role(official)
    def run():
        with connection(official) as conn:
            ids = []
            for p in request.parcels:
                geom = valid_geometry(conn, p.geometry)
                row = conn.execute('''WITH g AS (SELECT ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)) AS geom)
                    INSERT INTO land_parcels(department_id,parcel_reference,survey_number,district,ownership_type,geom,area_epsg,source,valid_from,valid_to,imported_by)
                    SELECT %s,%s,%s,%s,%s,geom,
                      (CASE WHEN ST_Y(ST_Centroid(geom)) >= 0 THEN 32600 ELSE 32700 END) +
                      LEAST(60,GREATEST(1,FLOOR((ST_X(ST_Centroid(geom))+180)/6)::integer+1)),
                      %s::jsonb,%s,%s,%s FROM g RETURNING id''',
                    (geom, official.department_id, p.parcel_reference, p.survey_number, p.district, p.ownership_type,
                     p.source.model_dump_json(), p.valid_from, p.valid_to, official.user_id)).fetchone()
                ids.append(str(row['id']))
            audit(conn, official, 'parcels_imported', {'parcel_ids': ids})
            return {'parcel_ids': ids, 'imported': len(ids)}
    return await run_in_threadpool(run)


def scoped_parcel(conn, official: Official, parcel_id: UUID):
    row = conn.execute('SELECT id FROM land_parcels WHERE department_id=%s AND id=%s', (official.department_id, parcel_id)).fetchone()
    if not row:
        raise HTTPException(404, 'Parcel was not found in your department.')


@router.post('/authorizations', status_code=201)
async def import_authorization(request: AuthorizationInput, official: Official = Depends(verified_official)):
    require_role(official)
    def run():
        with connection(official) as conn:
            scoped_parcel(conn, official, request.parcel_id)
            geom = valid_geometry(conn, request.geometry)
            row = conn.execute('''SELECT ST_CoveredBy(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),geom) AS covered
                FROM land_parcels WHERE department_id=%s AND id=%s''', (geom, official.department_id, request.parcel_id)).fetchone()
            if not row['covered']:
                raise HTTPException(422, 'Authorization footprint must be covered by the referenced parcel.')
            row = conn.execute('''INSERT INTO land_authorizations(department_id,parcel_id,authorization_reference,
                authorization_type,authorized_use,status,geom,valid_from,valid_to,issuing_department,document_reference,source,imported_by)
                VALUES (%s,%s,%s,%s,%s,%s,ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),%s,%s,%s,%s,%s::jsonb,%s) RETURNING id''',
                (official.department_id, request.parcel_id, request.authorization_reference, request.authorization_type,
                 request.authorized_use, request.status, geom, request.valid_from, request.valid_to,
                 request.issuing_department, request.document_reference, request.source.model_dump_json(), official.user_id)).fetchone()
            audit(conn, official, 'authorization_imported', {'authorization_id': str(row['id']), 'parcel_id': str(request.parcel_id)})
            return {'authorization_id': row['id']}
    return await run_in_threadpool(run)


@router.post('/observations', status_code=201)
async def import_observation(request: ObservationInput, official: Official = Depends(verified_official)):
    require_role(official, OBSERVATION_ROLES)
    def run():
        with connection(official) as conn:
            scoped_parcel(conn, official, request.parcel_id)
            geom = valid_geometry(conn, request.geometry)
            overlap = conn.execute('''SELECT ST_Area(ST_Intersection(geom,ST_SetSRID(ST_GeomFromGeoJSON(%s),4326))::geography) > 0 AS overlaps
                FROM land_parcels WHERE department_id=%s AND id=%s''', (geom, official.department_id, request.parcel_id)).fetchone()
            if not overlap['overlaps']:
                raise HTTPException(422, 'Observation footprint must overlap the referenced parcel.')
            row = conn.execute('''INSERT INTO land_observations(department_id,parcel_id,observed_at,scene_id,observed_use,geom,source,analysis_run_id,imported_by)
                VALUES (%s,%s,%s,%s,%s,ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),%s::jsonb,%s,%s) RETURNING id''',
                (official.department_id, request.parcel_id, request.observed_at, request.scene_id, request.observed_use,
                 geom, request.source.model_dump_json(), request.analysis_run_id, official.user_id)).fetchone()
            audit(conn, official, 'observation_imported', {'observation_id': str(row['id']), 'parcel_id': str(request.parcel_id)})
            return {'observation_id': row['id']}
    return await run_in_threadpool(run)


MONITOR_SQL = '''
WITH bank AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%(bankline)s),4326) AS geom),
selected AS (
  SELECT p.*, ST_Distance(p.geom::geography,b.geom::geography) AS distance_to_bank_m
  FROM land_parcels p CROSS JOIN bank b
  WHERE p.department_id=%(department)s AND p.valid_from <= %(as_of)s
    AND (p.valid_to IS NULL OR p.valid_to >= %(as_of)s)
    AND ST_DWithin(p.geom::geography,b.geom::geography,%(distance)s)
  ORDER BY distance_to_bank_m,p.id LIMIT 501
)
SELECT p.id,p.parcel_reference,p.survey_number,p.district,p.ownership_type,p.source,
 p.distance_to_bank_m,p.area_epsg,ST_Area(ST_Transform(p.geom,p.area_epsg)) AS area_m2,
 COALESCE(a.records,'[]'::jsonb) AS authorization_records,
 COALESCE(ST_Area(ST_Transform(ST_Intersection(p.geom,a.authorized_geom),p.area_epsg)),0) AS authorized_area_m2,
 o.id AS observation_id,o.observed_at,o.scene_id,o.source AS observation_source,o.analysis_run_id,
 CASE WHEN o.id IS NULL THEN NULL ELSE
 ST_Area(ST_Transform(ST_Intersection(p.geom,o.geom),p.area_epsg)) END AS observed_built_area_m2,
 CASE WHEN o.id IS NULL OR p.ownership_type <> 'government' THEN NULL ELSE
 ST_Area(ST_Transform(ST_Difference(ST_Intersection(p.geom,o.geom),
 COALESCE(a.authorized_geom,ST_GeomFromText('POLYGON EMPTY',4326))),p.area_epsg)) END AS potential_unregistered_area_m2
FROM selected p
LEFT JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'reference',a.authorization_reference,'status',a.status,
 'authorized_use',a.authorized_use,'valid_from',a.valid_from,'valid_to',a.valid_to,
 'document_reference',a.document_reference,'issuing_department',a.issuing_department,'source',a.source)) AS records,
 ST_Union(a.geom) FILTER (WHERE a.status='authorized') AS authorized_geom
 FROM land_authorizations a
 WHERE a.department_id=%(department)s AND a.parcel_id=p.id
   AND a.valid_from <= %(as_of)s AND (a.valid_to IS NULL OR a.valid_to >= %(as_of)s)
) a ON true
LEFT JOIN LATERAL (
 SELECT o.* FROM land_observations o
 WHERE o.department_id=%(department)s AND o.parcel_id=p.id AND o.observed_at <= %(as_of)s
 ORDER BY o.observed_at DESC,o.created_at DESC,o.id DESC LIMIT 1
) o ON true
ORDER BY p.distance_to_bank_m,p.id
'''


@router.post('/monitor')
async def monitor(request: MonitorInput, official: Official = Depends(verified_official)):
    def run():
        analysis_id = str(uuid4())
        with connection(official) as conn:
            bankline = valid_geometry(conn, request.bankline)
            rows = conn.execute(MONITOR_SQL, {'bankline': bankline, 'department': official.department_id,
                                             'as_of': request.as_of, 'distance': request.distance_m}).fetchall()
            if len(rows) > 500:
                raise HTTPException(422, 'This corridor includes over 500 parcels. Shorten the bankline or screening distance.')
            for row in rows:
                row['legal_status'] = authorization_status(row['authorization_records'])
                row['authorized_coverage_pct'] = 100 * row['authorized_area_m2'] / row['area_m2'] if row['area_m2'] else None
                row['observation_status'] = ('not_assessed' if row['observation_id'] is None else
                    'not_government_land' if row['ownership_type'] != 'government' else
                    'potential_unregistered_use_requires_verification' if (row['potential_unregistered_area_m2'] or 0) > 0.01 else
                    'observed_footprint_covered_by_record')
            audit(conn, official, 'land_monitor_requested', {'analysis_id': analysis_id, 'as_of': request.as_of.isoformat(),
                'distance_m': request.distance_m, 'parcel_count': len(rows), 'bankline_date': request.bankline_date.isoformat(),
                'bankline_source': request.bankline_source.model_dump(mode='json'), 'bankline': request.bankline.model_dump()})
            return {'analysis_id': analysis_id, 'department_id': official.department_id, 'as_of': request.as_of,
                'distance_m': request.distance_m, 'bankline_date': request.bankline_date,
                'bankline_source': request.bankline_source.model_dump(), 'parcels': rows,
                'calculation': {'evidence_level': 'derived', 'input_crs': 'EPSG:4326',
                    'distance': 'ST_DWithin(parcel::geography, bankline::geography, distance_m); ST_Distance on the WGS84 spheroid',
                    'area': 'ST_Area(ST_Transform(geometry, parcel.area_epsg)); metres² in local WGS84 UTM',
                    'potential_use': 'Area((observed built footprint ∩ government parcel) − active authorized footprint)',
                    'validity': 'valid_from ≤ as_of ≤ valid_to; a null valid_to is open-ended; conflicting statuses require review'},
                'limitations': ['A screening corridor is not a flood extent or a statutory setback.',
                    'Authorization reflects active department-imported records; missing or conflicting records require officer verification.',
                    'Imagery never proves legal status. Observations are imported evidence, not an automatic satellite detection.',
                    'An authorization footprint match does not confirm permitted land use, occupancy, title or compliance.',
                    'No restricted-zone dataset is queried by this monitor. Positional uncertainty is not quantified.']}
    return await run_in_threadpool(run)

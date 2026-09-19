# Government land panel

`/admin` extends the existing sign-in flow; it does not trust the role selected in the login dropdown. A public demo account cannot see department land records.

## Provisioning

1. Configure server-only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `DATABASE_URL`. Frontend sign-in retains `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Never put a service-role key or database password in a `VITE_*` variable.
2. In a trusted Supabase administrator environment, provision the user's **app_metadata** with `department_id` and `government_role`. User-editable `user_metadata` and the UI's selected profile grant no access.

```json
{"department_id":"revenue-ap","government_role":"revenue_officer"}
```

3. Apply the standalone migration as database owner:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/app/db/migrations/002_land_monitor.sql
```

It creates PostGIS-backed parcels, authorization footprints, observations and an append-only audit log. It is idempotent and does not require the older `schema.sql` tables. It does not load real government data.

4. Use dedicated non-owner, non-superuser, non-BYPASSRLS runtime credentials. Grant only schema usage and the necessary table privileges. The API needs SELECT and INSERT on the four land tables; it has no record deletion/update routes. Restrict connections to the trusted API. The API supplies `app.department_id` within each transaction, while explicit department predicates and forced row-level-security policies enforce scope. Do not expose this runtime database role or permit arbitrary SQL from clients.

Roles: `super_admin`, `government_admin`, `revenue_officer`, `urban_planner`, `environment_officer`, `disaster_manager`, `researcher`, `viewer`. All provisioned roles can read their own department. `government_admin`/`super_admin` can import parcels and authorizations; those roles plus `revenue_officer` can import observations. Even `super_admin` is scoped to its assigned department in these APIs.

## API and UI

All `/api/land/*` requests require a bearer token, verified against Supabase `/auth/v1/user` on the server. There is no government development bypass. Request bodies are capped at 2 MB, geometry vertex counts are bounded, and database statements time out after 15 seconds.

| Route | Purpose |
|---|---|
| `GET /api/land/session` | Verify role, department, database connection; audit session access |
| `GET /api/land/parcels?limit=100&offset=0` | Department-scoped register; API pagination up to 500 rows |
| `POST /api/land/parcels` | Import up to 100 sourced parcels atomically |
| `POST /api/land/authorizations` | Add a dated official record and its authorized/restricted footprint |
| `POST /api/land/observations` | Import a sourced observed built footprint with analysis reference |
| `POST /api/land/monitor` | Distance query, active records, footprint overlay and audit event |

The UI provides file/JSON imports, source metadata, a dated bankline upload, monitoring distance and as-of date, a result table, calculation details and JSON export. It never substitutes sample data if authentication, PostGIS or official records are missing.

## Import contracts

The following is a **schema example**, not an actual parcel or authorization. Replace every example identifier, geometry and source with permitted authoritative data before importing. GeoJSON uses longitude/latitude in EPSG:4326. All source objects require `name`, `record_id`, `retrieved_at` (ISO date) and `license`; `url` is optional.

```json
{
  "parcels": [{
    "parcel_reference": "EXAMPLE-REPLACE-WITH-REAL-REFERENCE",
    "survey_number": "EXAMPLE-SURVEY",
    "district": "Example district",
    "ownership_type": "government",
    "geometry": {"type":"Polygon","coordinates":[[[80.60,16.50],[80.601,16.50],[80.601,16.501],[80.60,16.501],[80.60,16.50]]]},
    "valid_from": "2020-01-01",
    "valid_to": null,
    "source": {"name":"Example department record","record_id":"EXAMPLE-REPLACE","retrieved_at":"2026-09-18","license":"Replace with actual permitted-use terms"}
  }]
}
```

The parcel import returns UUIDs. A subsequent authorization record uses a returned `parcel_id`:

```text
parcel_id: UUID
authorization_reference: unique department record reference
authorization_type: e.g. lease / permission / official restriction
authorized_use: recorded permitted use
status: authorized | unauthorized | revoked
geometry: Polygon or MultiPolygon inside the referenced parcel
valid_from: YYYY-MM-DD
valid_to: YYYY-MM-DD or null
issuing_department: source department name
document_reference: official document identifier
source: source metadata object described above
```

`unauthorized` is accepted only as an explicitly imported official-record status; it is never generated from satellite appearance. Record conflicts are preserved and require review. These are append-only imports with unique references, not a full adjudication or supersession system. Administrative correction/revocation history should be managed through a controlled migration/procedure until explicit versioned update routes are implemented.

An observation record has `parcel_id`, `observed_at`, `scene_id`, `observed_use: "built_up"`, polygon `geometry`, `source`, and `analysis_run_id`. It is externally supplied evidence; the government module does not currently perform automatic building segmentation or land-use classification.

The monitor request has:

```text
bankline: dated LineString or MultiLineString GeoJSON geometry
bankline_date: YYYY-MM-DD, no later than as_of
bankline_source: source metadata object
distance_m: 1–10000 (default 500)
as_of: YYYY-MM-DD, no later than today
```

Dates are inclusive: `valid_from ≤ as_of ≤ valid_to`, and null `valid_to` is open-ended. Authorization geometries must be covered by their referenced parcel. Observation geometries must overlap their parcel.

## Meaning of results

- Proximity: minimum spheroidal parcel-to-bankline distance in metres; touching/intersecting geometries can have zero distance.
- Record status: authorization/revocation/unauthorized status **on record**, or missing/conflicting records requiring verification.
- Authorized coverage: area of the union of active authorized footprints intersecting the parcel, divided by parcel area. A record can cover only part of a parcel; its presence never certifies the whole parcel.
- Potential unregistered use: `(observed built footprint ∩ government parcel) − active authorized footprints`. This is a review flag, not a legal ruling. It does not check whether the observed use complies with the authorized-use text.
- No observation: “not assessed”, not “no visible change”. The latest imported observation on/before the as-of date is used; its date/source remain visible in exported JSON.

Monitoring writes its inputs and analysis identifier to the audit log. JSON export is a browser operation, not a separate server report-generation event. There is no automatic cadastral portal connector, official-record verification, restricted-zone overlay, ownership adjudication or enforcement action. Acquire datasets through approved department channels. Use a staged PostGIS instance and two department accounts to verify tenant isolation before operational use; local tests do not replace that database deployment check.

# Deploying the research upgrade

The existing React/Vite/Cesium frontend and FastAPI service remain in place. Existing authentication, catalogue search, weather, incident context and evidence conversation are retained. New pages are `/research` and `/admin`; the existing static-host SPA rewrite already supports them.

## Render

Redeploy **both** services from the same Git commit:

- Frontend: `npm ci && npm run build`, publish `dist`.
- Backend: root directory `backend`, `pip install -r requirements.txt`, start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- Keep `VITE_BACKEND_BASE_URL` pointed at the API service, and add the frontend's origin to API `ALLOWED_ORIGINS`.
- Retain frontend `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, plus server `SUPABASE_URL` / `SUPABASE_ANON_KEY`, for real research and government access.
- Add server-only `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` to enable the real Sentinel-2 Process API route. A public STAC catalogue connection alone does not enable pixel processing. Check account permissions and processing quota.
- For government records, provision `DATABASE_URL`, apply `002_land_monitor.sql`, and provision government app metadata as described in [GOVERNMENT.md](GOVERNMENT.md).
- Keep `INTELLIGENCE_ALLOW_UNAUTHENTICATED=false`. Stored research explicitly rejects the legacy chat bypass; government access never uses it.

`ANALYSIS_DATA_DIR` holds SQLite job/provenance records and source/mask TIFFs. Default: `./data/analysis`, relative to the API working directory. **Render's ordinary filesystem is ephemeral.** For durable evidence, configure this variable to an existing persistent-disk mount and arrange backup/retention. The upgrade does not purchase a disk or silently claim permanent retention. No automatic data cleanup is currently scheduled; monitor storage and apply an institution-approved retention policy.

The job runner is for a **single API process/instance**: two concurrent workers, a queue cap of twelve, saved states and bounded request sizes. On startup it marks interrupted jobs failed, so they can be explicitly resubmitted. Do not run multiple Uvicorn workers or horizontally scale this SQLite-backed runner. Migrate job ownership/queue coordination to a shared database and Redis/Celery/RQ before scaling. `REDIS_URL` is not used by this implementation.

Geometry/sample results are cached by owner and complete input/version hash. Live satellite requests rediscover acquisitions rather than indefinitely caching a date-only request. Run IDs are immutable; source assets have hashes. Sample runs contain server-generated example geometry and are publicly readable by run ID; real runs/assets require the matching verified user. No government data is stored in public example runs.

## Local development and checks

```sh
npm ci
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
backend/.venv/bin/uvicorn app.main:app --app-dir backend --reload --port 8000
```

In another terminal:

```sh
npm run dev
```

The added frontend services default to `http://localhost:8000` only during Vite development. Production needs `VITE_BACKEND_BASE_URL` unless a same-origin API reverse proxy exists. Copy `.env.example` for frontend variables. Supply backend environment variables through the process environment or use Uvicorn `--env-file backend/.env`; simply creating `backend/.env` does not automatically load it.

```sh
npm run check
npm run build
npm run test:backend
npx playwright install chromium
npm test
```

Browser tests start isolated frontend/API servers on 4175/8005 with authentication and satellite credentials intentionally disabled. They verify the real example computation, calculation/source views and JSON download, mobile layout, the volume example, and government access denial. They do not test a live Copernicus account or a provisioned PostGIS server.

The GitHub verification workflow also provisions a disposable PostGIS database and runs the optional government integration test for real SQL imports, temporal authorization expiry and cross-department isolation. Locally this test is skipped unless `POSTGIS_TEST_URL` explicitly names an empty, disposable test database. Never point it at production.

## Krishna / Vijayawada walkthrough

1. Enter the existing workspace and select **River research**.
2. Choose **Krishna / Vijayawada**. The selected bounding box is a study area, not a river boundary.
3. Set Date A and Date B and a screening distance (e.g. 2000 m).
4. Without credentials, select **Synthetic calculation example** and run it. Every metric/layer is labelled EXAMPLE. These computed geometries do **not** describe the real Krishna River.
5. Inspect **How was this calculated?**, unit conversions, map layer visibility/opacity, source evidence and exported JSON/CSV/GeoJSON.
6. For actual imagery, use **Process Sentinel-2 imagery** while signed in and with server CDSE credentials. Set the search tolerance and, preferably, a seed coordinate inside the river. Review the actual selected dates, cloud coverage, selected component and source/mask TIFFs. If unusable imagery is found, choose another date; SAR fallback is not implemented.
7. Alternatively upload sourced dated water polygons, optionally including a centreline and valid-coverage geometry. Upload structure:

```json
{
  "observations": [
    {"date":"2018-10-01","geometry":{"type":"Polygon","coordinates":[]},"source":"REPLACE with actual source","scene_ids":[],"resolution_m":20,"is_sample":false},
    {"date":"2024-10-01","geometry":{"type":"Polygon","coordinates":[]},"source":"REPLACE with actual source","scene_ids":[],"resolution_m":20,"is_sample":false}
  ],
  "centerline": null
}
```

The empty coordinate arrays above are **schema placeholders and will be rejected**. Insert valid sourced geometries, use true acquisition dates, and include each observation's `valid_geometry` when clouds/nodata leave incomplete coverage. A centreline, if supplied, must be a simple LineString in WGS84. Omit `resolution_m`/use null for vectors without a meaningful pixel resolution.

8. Expand **Scientific calculators** for actual surveyed cross-section volume, raster depth integration, DEM difference, or signed-transect change rates. Prefilled values remain synthetic until replaced with measured inputs and their source. A real-input calculation requires sign-in.
9. In **Government**, only a provisioned department account can import parcels/authorizations and monitor an uploaded dated bankline corridor. Missing records or imagery are not treated as proof of unauthorized land use.
10. Use **Environment & urban news** to search an explicit place name. Results are source-linked context, not GIS observations or official alerts.

## API additions

| Route | Behavior |
|---|---|
| `GET /api/analysis/capabilities` | Explicitly reports configured/unsupported capabilities |
| `POST /api/analysis/plan` | Validated approved task plan; no arbitrary code |
| `POST /api/analysis/river` | Start a bounded background analysis; sample/GeoJSON/satellite modes |
| `GET /api/analysis/{id}` | Owner-scoped status/result; public synthetic runs contain no official data |
| `GET /api/analysis/{id}/calculations` | Exact numerical ledger |
| `GET /api/analysis/{id}/provenance` | Request, algorithm, CRS and evidence metadata |
| `GET /api/analysis/{id}/report` | Complete export-ready result object |
| `GET /api/analysis/{id}/assets/{filename}` | Owner-scoped source TIFF, mask or metadata |
| `POST /api/gis/calculate` | Explicit-input volume, DEM, bank-rate, water-index or exposure computation |
| `GET /api/news/geospatial?query=Vijayawada&category=flood` | Source-linked discovery or explicit unavailable/no-results state |

The `/api/gis/calculate` envelope is `{operation,source,parameters,is_sample}`. Supported operation names and keyword parameters are defined in `scientific_tools.py` and `gis_engine.py`; the UI examples provide complete executable input examples. No automatic ML/hydraulic forecasts, SAR verification, bathymetry acquisition, building segmentation or official cadastral connector is included. See [GIS_METHODS.md](GIS_METHODS.md) for formulas, primary references and precise limitations.

## Map selection and responsive workspace

Use **Search the map** to find a place, **Select location** to tap a square study area, or **Draw polygon** to outline a custom study boundary. Polygon mode accepts 3–200 corners; pan/zoom to your area first, then tap corners, Undo as needed and Finish. Cancel preserves the previous selection. Research AOIs must fit within 0.8 degrees per side, between 80°S and 84°N. Self-intersecting polygons are rejected. The backend independently validates the closed WGS84 geometry and its bounds.

**Coordinates & selection** supports latitude, longitude entry, square half-width selection (500 m–5 km) and GeoJSON export. These squares are study windows, not flood zones. Expand the map for more drawing space, and use Reset to fit the area north-up. The exact polygon is sent to catalogue intersections, satellite processing and deterministic GIS clipping; its bounding box remains a convenience for discovery/grid dimensions. Satellite pixel masks exclude the polygon's exterior. Weather products remain point/grid estimates rather than polygon-integrated measurements.

The renderer is CesiumJS; this is an independently implemented map interaction, not an embedded Google Earth feature. OpenStreetMap/Cesium attribution remains visible. Optional licensed Google 3D context requires the existing restricted Google Maps key. Toggling it no longer recreates the map or loses selection; failure retains the base map.

Desktop research/admin routes scroll normally; narrower screens put the map first and retain touch-sized controls. The login card can scroll on short screens.

For government account creation using Render environment variables, see [ADMIN_SETUP.md](ADMIN_SETUP.md).

### Map reliability and branding

The base globe uses the bundled open-source CesiumJS renderer, OpenStreetMap imagery and an ellipsoid terrain model. It does not call Cesium ion; `VITE_CESIUM_ION_TOKEN` is not needed or used by this viewer. The optional Google layer calls Google directly. The default ion promotional logo is removed using `CreditDisplay.cesiumCredit`; provider attribution remains visible. The shipped renderer license is available at `/licenses/CesiumJS-LICENSE.txt`. See the [public credit API](https://cesium.com/learn/cesiumjs/ref-doc/CreditDisplay.html) and [Cesium's explanation for non-ion applications](https://community.cesium.com/t/remove-cesiumion-logo/25502).

A failed optional Google layer does not replace the base map with a WebGL error. Genuine initialization or graphics-context failures show **Retry map** while retaining the AOI and search controls. The old toolbar labelled “Select on globe” is from an earlier release; reload an existing browser tab to load the current “Select location / Draw polygon” controls.

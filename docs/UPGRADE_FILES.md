# Upgrade file map

## Added backend files

- `backend/app/analysis.py`: validated question/date/AOI plans, protected river jobs, status, calculation/provenance/report and evidence download endpoints.
- `backend/app/analysis_store.py`: SQLite job records, owner-scoped cache lookup and interrupted-job recovery.
- `backend/app/gis_engine.py`: local CRS geometry, water-edge/area/width/change/buffer measurements, water indices, transect rates and volume math.
- `backend/app/satellite.py`: actual Sentinel-2 source-pixel acquisition, masking, classification, evidence files and hashes.
- `backend/app/scientific_tools.py`: explicit-input scientific calculation API and geometry exposure intersections.
- `backend/app/land.py`: verified department roles, authoritative record imports, PostGIS proximity/authorization overlays and audit actions.
- `backend/app/news.py`: bounded source-linked GDELT discovery with official publisher labels and distinct outage states.
- `backend/app/db/migrations/002_land_monitor.sql`: standalone land records, indexes, forced department RLS and append-only audit schema.
- `backend/requirements-dev.txt`: backend test dependencies.
- `backend/tests/test_gis_engine.py`: mathematically known geometry/index/volume/change fixtures.
- `backend/tests/test_analysis_api.py`: job persistence, evidence ownership, authentication and request-validation tests.
- `backend/tests/test_satellite.py`: raster processing, clouds, source metadata, seeds and evidence archive tests.
- `backend/tests/test_land.py`: role, validity and scoped-query guards.
- `backend/tests/test_land_postgis.py`: optional disposable-PostGIS integration for SQL imports, expired authorizations and department separation.
- `backend/tests/test_news.py`: provider errors, safe URLs, timestamps and deduplication.

## Added frontend files

- `src/components/RiverWorkspace.tsx`: research form, source modes, progress, metrics, numerical ledger, temporal display, result exports and layer controls.
- `src/components/ScientificCalculators.tsx`: explicit-input volume, DEM difference, water-index and bank-rate calculator UI.
- `src/components/GovernmentPanel.tsx`: protected government workspace, record imports, bankline corridor query and evidence table.
- `src/components/NewsPanel.tsx`: place/topic news discovery and official resource links.
- `src/services/research.ts`: typed GIS API client, authenticated source downloads and export helpers.
- `src/styles/research.css`, `src/styles/government.css`, `src/styles/news.css`: responsive additions following the existing dark/yellow visual identity.
- `tests/browser/research.spec.ts`: end-to-end calculations/export, government denial and mobile/volume checks.
- `playwright.config.ts`: isolated browser-test services and demo configuration.

## Added documentation/configuration

- `docs/GIS_METHODS.md`: formulas, scientific limitations and primary research references.
- `docs/GOVERNMENT.md`: provisioned roles, database migration, import contracts and result interpretation.
- `docs/RESEARCH_SETUP.md`: Render/environment/storage setup, Krishna walkthrough and API guide.
- `docs/UPGRADE_FILES.md`: this change map.
- `pytest.ini`: Python test discovery/import path.
- `.github/workflows/verify.yml`: frontend/backend/browser verification with disposable PostGIS.

## Modified existing files

- `src/App.tsx`: workspace navigation and `/research`/`/admin` integration, retaining the original workspace.
- `src/components/CesiumGlobe.tsx`: asynchronous GeoJSON result layers and opacity with cleanup/error handling.
- `backend/app/main.py`: new routers and interrupted-job startup recovery.
- `backend/requirements.txt`: scientific GIS/raster and PostGIS client dependencies.
- `backend/.env.example`, `render.yaml`: evidence-storage configuration and deployment notes.
- `package.json`, `package-lock.json`: browser test dependency and test commands.
- `.gitignore`: excludes local data, caches and test outputs.
- `README.md`: capabilities and setup/methods links, with explicit unsupported forecast/ML boundaries.

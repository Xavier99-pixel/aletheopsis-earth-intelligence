# ALETHEOPSIS production architecture

## 1. Product rule

The language model plans and explains. Deterministic geospatial services calculate measurements. Every decision-relevant claim must return an evidence record with source asset, acquisition time, sensor, spatial extent, processing steps, model/tool version, quality checks and confidence decision.

```text
Browser / mobile app
  -> identity and policy gateway
  -> query planner
  -> data catalogue + imagery job router
  -> optical / SAR / time-series workers
  -> PostGIS measurement and topology service
  -> evidence verifier + audit report
  -> grounded response, map layers and export
```

## 2. Recommended technology stack

| Layer | MVP | Future scale |
|---|---|---|
| Web | TypeScript, React, Vite, CesiumJS | Next.js or React micro-frontends, CesiumJS, WebGL/WebGPU overlays |
| Mobile | Flutter | Flutter with offline tile cache, secure device storage and background job status |
| API | Python FastAPI | FastAPI services behind an API gateway; gRPC only for high-throughput internal geoprocessing |
| Planner | Typed tool router + prompt templates | LangGraph / Temporal workflow orchestration, tool policies and evaluation suite |
| GIS | PostGIS, GDAL, Rasterio, GeoPandas | PostGIS read replicas, pgSTAC, TiTiler, Dask / Ray / Spark for large jobs |
| ML | Segmentation/change-detection worker | GPU inference service, model registry (MLflow), feature store and drift monitoring |
| Identity | Supabase Auth for MVP | Keycloak/Auth0 or government SSO, MFA, RBAC + ABAC, tenant isolation |
| Async jobs | Redis + Celery/RQ | Temporal, RabbitMQ/Kafka/SQS and horizontally scalable workers |
| Observability | Structured logs + Sentry | OpenTelemetry, Prometheus/Grafana, SIEM export, immutable audit store |

## 3. Map and visualisation choice

Use **CesiumJS** as the main globe. It supports AOIs, time-aware raster overlays, polygons, evidence layers, terrain and future 3D layers.

Optionally add Google Maps Platform Photorealistic 3D Tiles through CesiumJS when a licensed Google Maps key is available. Treat those tiles as contextual visualisation only. They cannot become analysis input or evidence. For evidence and analytics use Sentinel products, user uploads, or authorised institutional sources.

## 4. Environmental variables

### Browser-safe variables

These may use the `VITE_` prefix. They are intentionally visible to browser clients, so restrict them by domain / referrer and never store secrets in them.

| Variable | Purpose |
|---|---|
| `VITE_APP_ENV` | `development`, `staging` or `production` label |
| `VITE_BACKEND_BASE_URL` | HTTPS URL of the FastAPI gateway |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase public anonymous key |
| `VITE_GOOGLE_MAPS_API_KEY` | Referrer-restricted Google Maps key for optional photorealistic 3D visualisation |
| `VITE_CESIUM_ION_TOKEN` | URL-restricted Cesium ion token, only when Cesium ion assets are used |

### Backend-only secrets

Keep these in Render/secret manager configuration only. Do not prefix them with `VITE_`, commit them, or return them to the browser.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL/PostGIS connection string |
| `REDIS_URL` | Queue, cache and background-job broker |
| `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` | Copernicus Data Space OAuth client credentials |
| `OPENAI_API_KEY` | Optional hosted evidence-synthesis provider key; API only, never browser-visible |
| `OPENAI_MODEL` | Optional server-side hosted model selection |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Validate a signed-in user's access token before hosted synthesis |
| `INTELLIGENCE_MAX_REQUESTS_PER_MINUTE` | Per-instance guard for hosted synthesis; move to Redis for multi-instance production |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` | S3, R2 or MinIO raster/evidence object storage |
| `SUPABASE_JWT_SECRET` or `OIDC_JWKS_URL` | Verify user access tokens on the API |
| `GOOGLE_MAPS_API_KEY` | Server-side key only if server APIs are used; separate from browser-restricted visualisation key |
| `MLFLOW_TRACKING_URI` | Model registry endpoint |
| `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT` | Error reporting and traces |
| `KMS_KEY_ID` | Encryption key reference for sensitive AOIs / uploads |

## 5. Environmental and Earth-observation variables to store

Store raw source files in object storage and searchable metadata/derived values in databases. Do not duplicate public imagery unnecessarily.

| Group | Important variables |
|---|---|
| Acquisition metadata | source catalogue ID, item ID, sensor, product level, acquisition start/end, orbit/pass, cloud cover, licence, checksum |
| Optical bands | B02/B03/B04/B08, red-edge, SWIR bands, reflectance scale, cloud/shadow mask |
| SAR variables | polarization, incidence angle, orbit direction, calibrated backscatter, coherence, speckle filter version |
| Land/water indicators | NDVI, NDWI/MNDWI, NDBI, burn index, soil moisture proxy, flood-mask class |
| Weather context | rainfall, temperature, wind, humidity, pressure, cloud fraction, lightning, forecast timestamp and provider |
| Hydrology | river level, discharge, reservoir level, flood warning, catchment ID, soil moisture |
| Terrain | DEM elevation, slope, aspect, drainage direction, flow accumulation, landform |
| Change evidence | before/after item IDs, change polygon, changed area, perimeter, date gap, registration error, class score |
| Quality / uncertainty | CRS, pixel resolution, cloud %, no-data %, co-registration error, model version, confidence, abstention reason |

## 6. Databases and what belongs in each

| Store | What to use it for |
|---|---|
| **PostgreSQL + PostGIS** | users, organisations, roles, AOIs, geospatial vectors, query metadata, measurement results, evidence links, access policies and audit records |
| **pgSTAC** (Postgres extension/schema) | your STAC catalogue if you mirror or catalogue imagery/assets internally |
| **Object storage: S3 / Cloudflare R2 / MinIO** | GeoTIFF/COG, uploaded GeoJSON/KML, raster masks, thumbnails, tile caches, reports and immutable evidence packages |
| **Redis** | short-lived sessions, rate limits, job queues, map/tile and catalogue caches. Never use as the audit source of truth |
| **TimescaleDB** (Postgres extension) | high-frequency weather, hydrology, sensor and environmental time-series observations |
| **pgvector or Qdrant** | retrieval for documentation, policy manuals, tool descriptions and historical report search. Do not use a vector DB as geospatial truth |
| **OpenSearch** (later) | cross-tenant text search over audit reports, source metadata and operations logs |
| **Data lake: Parquet + DuckDB/Spark** (later) | large-scale historical training, data preparation and batch trend analysis |

### Suggested PostGIS core tables

```text
organisations, users, role_bindings, data_sources, source_policies,
areas_of_interest, imagery_items, imagery_assets, processing_jobs,
processing_steps, analysis_runs, evidence_claims, evidence_links,
measurements, change_polygons, model_versions, audit_events, exports
```

Every evidence claim should have a direct relationship to an `analysis_run`, spatial geometry, source `imagery_item`, tool/model version, and a confidence or abstention record.

## 7. Data connector plan

1. **Public MVP**: Copernicus Data Space STAC + Sentinel Hub Process/Catalog APIs for Sentinel-1 and Sentinel-2 discovery / rendering. Use OAuth on the backend.
2. **User uploads**: accept GeoTIFF, COG, GeoJSON, KML and shapefiles only through a virus scan, CRS validation, size limit, metadata extraction and private object storage.
3. **Government data**: create source-specific connectors behind organisation policy. The connector must enforce role, purpose, geographic scope, retention and logging before access.
4. **NISAR / specialised sources**: add only after the source’s current catalogue, access route, product availability and licence are confirmed.

## 8. Scale in phases

### Phase 1: hackathon MVP

- React/Cesium frontend, Supabase Auth, FastAPI API, PostGIS, one Sentinel-2 RGB/NDVI route, one Sentinel-1 flood route, S3/R2 storage and a basic evidence report.
- Hard-limit AOI size and date range. Use async jobs for all imagery work.

### Phase 2: pilot

- Organisations, RBAC, curated source policies, audit logs, Celery/Redis workers, STAC search caching, TiTiler raster tiles and scheduled monitoring.
- Add a reviewer workflow: analyst validates the model result before report release.

### Phase 3: production

- Tenant isolation, SSO/MFA, KMS encryption, immutable logs, independent model evaluation, model registry, alert rules, load testing, disaster recovery, data retention policies and governed government connectors.
- Move bulk processing to Dask/Ray/Spark or managed batch compute. Keep interactive map requests small and cached.

## 9. GitHub and Render sequence

1. Put this project in a dedicated Git repository.
2. Commit source files and `render.yaml`, never `.env` files or data credentials.
3. Deploy the static React app through Render Blueprint.
4. Deploy the FastAPI service as a separate Render web service or container service.
5. Use a managed Postgres instance with PostGIS enabled and an S3-compatible object store.
6. Add production secrets in Render’s environment settings, configure allowed CORS origins, and test Google OAuth redirect URLs before inviting users.

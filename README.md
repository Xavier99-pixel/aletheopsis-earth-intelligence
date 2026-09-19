# ALETHEOPSIS (Α◉)

## Auditable research and government upgrade

The existing Earth workspace now also links to **River research** (`/research`) and a server-protected **Government land monitor** (`/admin`).

- Real local-UTM area, observed water-edge length, supplied-centreline width sampling, dated water-footprint changes and 500 m / 1 km / custom distance screens.
- An authenticated Sentinel-2 Process API pipeline with cloud/nodata masking, NDWI/MNDWI, Otsu classification, connected-component selection, source TIFF/mask retention and contributing-tile provenance. Requires server CDSE credentials; no pixels are invented from catalogue metadata.
- Dated GeoJSON imports and clearly labelled synthetic examples, inspectable calculation equations/inputs, Cesium result layers, temporal area views and JSON/CSV/GeoJSON export.
- Explicit-input volume, DEM-difference and DSAS-style transect-rate calculators. A channel volume or flood prediction is never inferred from a 2D water polygon alone.
- Supabase-verified department roles, PostGIS parcel/authorization/observation imports, dated proximity checks, record-based status, potential-use review flags and audit logs.
- Source-linked environment/urban/flood news discovery, with unavailable/empty-result states and official reference links.

Start with [research deployment and the Krishna walkthrough](docs/RESEARCH_SETUP.md), [scientific methods and primary sources](docs/GIS_METHODS.md), and [government database/access setup](docs/GOVERNMENT.md).

**Scope:** distance screens are not flood forecasts. HEC-RAS/ML forecasting, automatic bathymetry acquisition, SAR validation, automatic building segmentation and live official cadastral connectors are not implemented. Real imagery and government operations require the listed credentials/datasets. Research job storage needs a persistent disk for retention across Render redeploys. The original workspace described below remains available.

ALETHEOPSIS is an Earth-observation workspace built around a 3D globe, real Copernicus catalogue metadata, source-aware investigation controls, and evidence-first assessment.

## What runs now

- A globe-first black, white and signal-yellow operator interface built with React, TypeScript and CesiumJS.
- Public, live catalogue discovery from the Copernicus Data Space STAC API for Sentinel-2 L2A and Sentinel-1 GRD.
- Actual acquisition identifiers, timestamps, cloud-cover metadata, platform, orbit and SAR polarization where returned by the catalogue.
- Place search and direct globe selection, date range, sensor selection and source query handling.
- Live coordinate-specific atmospheric intelligence: current conditions, a seven-day precipitation forecast, a recent 30-day rainfall pattern, and a monthly climate baseline. The forecast is rendered as weather context, never silently promoted to a flood or damage prediction.
- An evidence-bounded intelligence conversation: it can answer follow-up questions about measurements, available scenes, methods, live weather, incident records and outstanding evidence without inventing a pixel-derived finding. When configured, a signed-in user can opt into a protected server-side hosted synthesis of that same visible evidence; the deterministic local answer remains the fallback.
- Evidence-led processing modules explicitly show what has been computed (AOI geometry) versus what is ready for source-pixel processing (vegetation, change, flood extent and objects), together with the required method and available scene identifiers.
- Disaster-mode time-window context: NASA EONET public incident records are queried against the selected AOI and dates, while the atmospheric route separates historical daily-rainfall context from forecast days. An empty feed is explicitly not presented as proof that no incident occurred.
- Downloadable, self-contained research records in printable HTML, Markdown or JSON, carrying the question, AOI, calculation method, atmospheric data, output, source links, incident context and caveats.
- A FastAPI service that safely proxies catalogue searches and contains the server-only Sentinel Hub rendering route.
- Optional Google Maps Platform Photorealistic 3D Tiles as a contextual visual layer when a licensed restricted key is configured.
- PostGIS schema, local Docker setup, Render Blueprint, and sign-in boundary for Supabase Google/email authentication.

The application deliberately does not invent flood extents, object counts, vegetation loss, geometry measurements, or predictive scores. Those are released only after a server-side processing job attaches source assets, a deterministic GIS result, quality information and (for prediction) a validated model record.

## Start locally

Frontend:

```bash
npm install
cp .env.example .env.local
npm run dev
```

API:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
backend/.venv/bin/uvicorn app.main:app --app-dir backend --reload --port 8000
```

The default frontend configuration uses `http://localhost:8000`. If the API is not running, the public STAC metadata query can fall back to the Copernicus endpoint. Never put `CDSE_CLIENT_SECRET`, database credentials, or storage credentials in a `VITE_*` variable.

## Product boundaries

- **Latest available acquisition is not live streaming.** The interface displays source time and quality so operational teams can assess latency.
- **Google 3D tiles are visual context only.** They must not be cached, analysed, used for model input, or offered as evidence. Sentinel/authorised sources remain the evidence layer.
- **NISAR is not shown as a connected live feed.** Its L-band and S-band source routes need a separate Earthdata/ASF or authorised ISRO connector before use.
- **Conversation is evidence-bounded.** The optional hosted route accepts only the question and displayed evidence contract, verifies a Supabase session on the server, and may not turn catalogue metadata, weather context or an incident feed into an unverified impact claim. It is never a source of GIS measurements or predictive scores.

## Production setup

Read [docs/SETUP.md](docs/SETUP.md) for Copernicus, PostGIS, Google Maps/Google sign-in, Render and GitHub setup. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, security boundary and scaling plan.

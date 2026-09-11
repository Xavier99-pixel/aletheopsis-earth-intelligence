# ALETHEOPSIS (Α◉)

ALETHEOPSIS is an Earth-observation workspace built around a 3D globe, real Copernicus catalogue metadata, source-aware investigation controls, and evidence-first assessment.

## What runs now

- A globe-first black, white and signal-yellow operator interface built with React, TypeScript and CesiumJS.
- Public, live catalogue discovery from the Copernicus Data Space STAC API for Sentinel-2 L2A and Sentinel-1 GRD.
- Actual acquisition identifiers, timestamps, cloud-cover metadata, platform, orbit and SAR polarization where returned by the catalogue.
- Map-selected AOIs, date range, sensor selection and source query handling.
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

## Production setup

Read [docs/SETUP.md](docs/SETUP.md) for Copernicus, PostGIS, Google Maps/Google sign-in, Render and GitHub setup. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, security boundary and scaling plan.

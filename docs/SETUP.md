# ALETHEOPSIS setup guide

## 1. Copernicus data access

The UI can query public STAC metadata now. The public catalogue endpoint is:

```text
https://stac.dataspace.copernicus.eu/v1/search
```

It is used for `sentinel-2-l2a` and `sentinel-1-grd` scene discovery. The app displays the returned acquisition ID, time and quality metadata; it does not turn metadata into an analytical claim.

For true-colour, NDVI or SAR image processing:

1. Create a Copernicus Data Space account.
2. In the Sentinel Hub dashboard, create an OAuth client.
3. Place the client ID and secret in the **backend** Render service as `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET`.
4. Never expose either value in the frontend, GitHub, a browser request or a `VITE_*` variable.
5. The API caches the OAuth token, then uses the Sentinel Hub Process API for small AOI renders. Large jobs should run through a queue and preserve source item IDs and output checksums.

Official references: [CDSE STAC](https://documentation.dataspace.copernicus.eu/APIs/STAC.html), [CDSE authentication](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html), [Sentinel Hub Process API](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process.html).

## 2. Database and storage

Use PostgreSQL with PostGIS as the system of record. The schema is at [`backend/app/db/schema.sql`](../backend/app/db/schema.sql).

For local development:

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

For Render, provision a Postgres database with the PostGIS extension, then set its private connection URL as `DATABASE_URL` on the API service. Use an S3-compatible bucket (Cloudflare R2, AWS S3 or MinIO) for GeoTIFF/COG files, masks, visual renders and evidence packages. Store the object URI, checksum, STAC item ID and processing metadata in PostGIS—not raster files themselves.

Use these PostGIS operations in the processing service, never a language model, for decision values:

- `ST_Area(ST_Transform(...))` for area;
- `ST_Intersection`, `ST_Difference` and `ST_Intersects` for change/topology;
- `ST_MakeValid` before persisting polygon evidence.

Reference: [PostGIS documentation](https://postgis.net/documentation/).

## 3. Google Maps Platform 3D visual context

This is optional. It makes Cesium render Google Maps Platform Photorealistic 3D Tiles as a visual context layer; it is not analysis data.

1. Create or select a Google Cloud project.
2. Attach billing and enable **Map Tiles API**.
3. Create an API key and restrict it by HTTP referrer to the Render URL and local development origin.
4. Set the restricted key as `VITE_GOOGLE_MAPS_API_KEY` in the frontend service.
5. Keep Google attribution visible. Do not cache, extract, run ML on, measure from, or use those tiles as source evidence.

Map Tiles requires billing and a key/OAuth token. Check the current pricing/quota in the Google console before publishing. References: [usage and billing](https://developers.google.com/maps/documentation/tile/usage-and-billing), [Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies).

## 4. Google sign-in through Supabase

The web app uses Supabase Auth as the sign-in boundary. Configure it before enabling external users:

1. Create a Supabase project, then copy the project URL and publishable/anonymous key to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the frontend service.
2. In Google Cloud Console, create an OAuth consent screen and a **Web application** OAuth client.
3. Add the Authorized JavaScript origins for the local app (`http://localhost:5173`) and final Render frontend origin.
4. Copy the exact callback URL from Supabase Auth > Providers > Google into the OAuth client's Authorized redirect URIs. It normally follows `https://<project-ref>.supabase.co/auth/v1/callback`.
5. Paste the Google client ID and client secret into the Google provider settings in Supabase—not into the web application.
6. Add both local and production return URLs to Supabase Auth > URL Configuration > Redirect URLs, because the app uses `redirectTo: window.location.origin`.

Exact redirect URI matching is required; production origins must use HTTPS. References: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google), [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [Google OAuth redirect validation](https://developers.google.com/identity/protocols/oauth2/web-server).

## 5. Environment variables

Frontend browser-visible variables:

```dotenv
VITE_APP_ENV=production
VITE_BACKEND_BASE_URL=https://your-api.onrender.com
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-key
VITE_GOOGLE_MAPS_API_KEY=your-referrer-restricted-key
VITE_CESIUM_ION_TOKEN=optional-url-restricted-token
```

Backend-only variables:

```dotenv
ALLOWED_ORIGINS=https://your-frontend.onrender.com
CDSE_CLIENT_ID=server-only
CDSE_CLIENT_SECRET=server-only
DATABASE_URL=server-only
REDIS_URL=server-only
OPENAI_API_KEY=server-only
OPENAI_MODEL=gpt-5.2
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=server-only-supabase-publishable-key
INTELLIGENCE_MAX_REQUESTS_PER_MINUTE=12
S3_ENDPOINT=server-only
S3_ACCESS_KEY_ID=server-only
S3_SECRET_ACCESS_KEY=server-only
S3_BUCKET=server-only
```

## 6. Optional hosted intelligence synthesis

The browser always keeps the deterministic evidence answer available. The hosted synthesis switch only appears once the frontend knows the API URL, and it only sends the user question plus the evidence already visible in the workspace after the user opts in.

1. Deploy the FastAPI service first and configure `ALLOWED_ORIGINS` with the exact frontend origin.
2. On that **API service only**, set `OPENAI_API_KEY`. Do not create a `VITE_OPENAI_API_KEY` variable and do not add the key to Supabase, GitHub or the static frontend service.
3. Set `OPENAI_MODEL` only if you need to select a supported server-side model; otherwise leave the blueprint default.
4. Copy the existing Supabase project URL and anonymous/publishable key to the API service as `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The API validates the signed-in user's Supabase access token before it spends a hosted-model request.
5. Set `INTELLIGENCE_MAX_REQUESTS_PER_MINUTE` (the blueprint uses `12`). This is a per-instance protective limit; add Redis-backed rate limiting before a multi-instance production rollout.
6. Leave `INTELLIGENCE_ALLOW_UNAUTHENTICATED` unset or `false` in Render. It exists only for a deliberately local development test.
7. Set `VITE_BACKEND_BASE_URL` on the **frontend** to the API's HTTPS URL and redeploy the static site, because Vite variables are compiled into the frontend build.

The route uses a fixed server-side instruction, omits all provider keys from the browser, sends an opaque hashed user identifier for provider safety controls, and returns the deterministic evidence claim status rather than letting a model promote it. If the API, authentication or model provider is unavailable, the UI continues with its local evidence-bound answer.

Reference: [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## 7. NISAR source policy

NISAR mission information is useful for source planning, but `nisar.jpl.nasa.gov` is not the operational imagery API. Do not label NISAR connected until a source connector has been tested. For L-band, create a server-side Earthdata/ASF workflow; validate ISRO Bhoonidhi access requirements separately for S-band products. Preserve product ID, acquisition time, processing level, licence and source URL in the evidence record.

References: [NASA NISAR mission](https://science.nasa.gov/mission/nisar/), [ASF NISAR access overview](https://nisar-docs.asf.alaska.edu/access-overview/).

## 8. GitHub and Render

1. Create an empty repository named `aletheopsis-earth-intelligence` under the chosen GitHub account.
2. Keep `.env`, `backend/.env`, `.venv`, `node_modules` and `dist` out of Git.
3. Push this project to the default branch.
4. In Render, choose **New > Blueprint** and select the repository. The supplied `render.yaml` creates a static frontend and FastAPI API service.
5. Deploy the API first, copy its HTTPS URL into `VITE_BACKEND_BASE_URL` on the frontend service, then redeploy the frontend.
6. Add the frontend URL to `ALLOWED_ORIGINS` on the API service and to Supabase redirect settings.
7. For hosted synthesis, add the API-only variables in section 6, then redeploy the API and the frontend.

Do not enable production data processing until the API has CDSE credentials, a PostGIS connection, object storage and an audit strategy.

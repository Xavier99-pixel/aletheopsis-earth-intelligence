CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisation(id),
  external_subject text UNIQUE NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE area_of_interest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisation(id),
  owner_id uuid REFERENCES app_user(id),
  name text NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ST_IsValid(geom))
);

CREATE INDEX area_of_interest_geom_gix ON area_of_interest USING gist (geom);

CREATE TABLE stac_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  collection text NOT NULL,
  item_id text NOT NULL,
  acquired_at timestamptz NOT NULL,
  cloud_cover double precision,
  footprint geometry(Geometry, 4326),
  properties jsonb NOT NULL,
  assets jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, collection, item_id)
);

CREATE INDEX stac_item_acquired_at_idx ON stac_item (acquired_at DESC);
CREATE INDEX stac_item_footprint_gix ON stac_item USING gist (footprint);
CREATE INDEX stac_item_properties_gin ON stac_item USING gin (properties);

CREATE TABLE analysis_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisation(id),
  requested_by uuid REFERENCES app_user(id),
  aoi_id uuid REFERENCES area_of_interest(id),
  question text NOT NULL,
  selected_sources jsonb NOT NULL,
  selected_tools jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'withheld')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analysis_job_org_created_idx ON analysis_job (organisation_id, created_at DESC);

CREATE TABLE evidence_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_job_id uuid NOT NULL REFERENCES analysis_job(id) ON DELETE CASCADE,
  stac_item_id uuid REFERENCES stac_item(id),
  claim_type text NOT NULL,
  geom geometry(Geometry, 4326),
  object_uri text,
  sha256 text,
  processing jsonb NOT NULL,
  quality jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evidence_record_job_idx ON evidence_record (analysis_job_id);
CREATE INDEX evidence_record_geom_gix ON evidence_record USING gist (geom);

CREATE TABLE measurement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_record_id uuid NOT NULL REFERENCES evidence_record(id) ON DELETE CASCADE,
  name text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisation(id),
  actor_id uuid REFERENCES app_user(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_org_created_idx ON audit_event (organisation_id, created_at DESC);

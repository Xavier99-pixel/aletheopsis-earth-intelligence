-- Run as the database owner. Runtime credentials should use a non-owner role.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS land_parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id text NOT NULL,
  parcel_reference text NOT NULL,
  survey_number text NOT NULL,
  district text NOT NULL,
  ownership_type text NOT NULL CHECK (ownership_type IN ('government','private','other','unknown')),
  geom geometry(MultiPolygon,4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  area_epsg integer NOT NULL CHECK (area_epsg BETWEEN 32601 AND 32660 OR area_epsg BETWEEN 32701 AND 32760),
  source jsonb NOT NULL,
  valid_from date NOT NULL,
  valid_to date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  imported_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, parcel_reference),
  UNIQUE (department_id, id)
);
CREATE INDEX IF NOT EXISTS land_parcels_geography_idx ON land_parcels USING gist ((geom::geography));
CREATE INDEX IF NOT EXISTS land_parcels_department_idx ON land_parcels(department_id);

CREATE TABLE IF NOT EXISTS land_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id text NOT NULL,
  parcel_id uuid NOT NULL,
  authorization_reference text NOT NULL,
  authorization_type text NOT NULL,
  authorized_use text NOT NULL,
  status text NOT NULL CHECK (status IN ('authorized','unauthorized','revoked')),
  geom geometry(MultiPolygon,4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  valid_from date NOT NULL,
  valid_to date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  issuing_department text NOT NULL,
  document_reference text NOT NULL,
  source jsonb NOT NULL,
  imported_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, authorization_reference),
  FOREIGN KEY (department_id, parcel_id) REFERENCES land_parcels(department_id,id)
);
CREATE INDEX IF NOT EXISTS land_authorizations_parcel_idx ON land_authorizations(department_id,parcel_id,valid_from);

CREATE TABLE IF NOT EXISTS land_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id text NOT NULL,
  parcel_id uuid NOT NULL,
  observed_at date NOT NULL,
  scene_id text NOT NULL,
  observed_use text NOT NULL CHECK (observed_use = 'built_up'),
  geom geometry(MultiPolygon,4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  source jsonb NOT NULL,
  analysis_run_id text NOT NULL,
  imported_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (department_id, parcel_id) REFERENCES land_parcels(department_id,id)
);
CREATE INDEX IF NOT EXISTS land_observations_parcel_idx ON land_observations(department_id,parcel_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS land_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS land_audit_department_idx ON land_audit_log(department_id,created_at DESC);

-- Defence in depth: API queries also explicitly scope every read/write.
ALTER TABLE land_parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE land_parcels FORCE ROW LEVEL SECURITY;
ALTER TABLE land_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE land_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE land_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE land_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE land_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE land_audit_log FORCE ROW LEVEL SECURITY;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['land_parcels','land_authorizations','land_observations','land_audit_log'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = table_name AND policyname = 'land_department_scope') THEN
      EXECUTE format('CREATE POLICY land_department_scope ON %I USING (department_id = current_setting(''app.department_id'', true)) WITH CHECK (department_id = current_setting(''app.department_id'', true))', table_name);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION reject_land_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Land audit records are append-only';
END $$;
DROP TRIGGER IF EXISTS land_audit_append_only ON land_audit_log;
CREATE TRIGGER land_audit_append_only BEFORE UPDATE OR DELETE ON land_audit_log
FOR EACH ROW EXECUTE FUNCTION reject_land_audit_mutation();

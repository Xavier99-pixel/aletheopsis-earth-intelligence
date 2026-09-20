import type { CatalogScene, InvestigationRequest, SensorId } from "../lib/types";

const CDSE_STAC_SEARCH = import.meta.env.VITE_STAC_API_URL || "https://stac.dataspace.copernicus.eu/v1/search";
const configuredBackend = import.meta.env.VITE_BACKEND_BASE_URL?.replace(/\/$/, "");

type StacFeature = {
  id: string;
  bbox?: number[];
  links?: Array<{ rel?: string; href?: string }>;
  assets?: Record<string, { roles?: string[] }>;
  properties?: Record<string, unknown>;
};

type StacSearchResponse = {
  features?: StacFeature[];
};

type BackendSearchResponse = {
  items?: CatalogScene[];
  source?: string;
};

export type CatalogueSearchResult = {
  items: CatalogScene[];
  sourceName: string;
  sourceUrl: string;
};

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normaliseFeature(feature: StacFeature): CatalogScene {
  const properties = feature.properties ?? {};
  const bbox = feature.bbox?.length === 4 && feature.bbox.every((value) => typeof value === "number")
    ? feature.bbox as [number, number, number, number]
    : undefined;
  const collection = feature.id.startsWith("S1") ? "sentinel-1-grd" : "sentinel-2-l2a";
  const selfLink = feature.links?.find((link) => link.rel === "self")?.href;
  const rawPolarizations = properties["sar:polarizations"] ?? properties["sar:polarisation"];

  return {
    id: feature.id,
    collection,
    datetime: asString(properties.datetime) ?? asString(properties.start_datetime) ?? "Unknown acquisition time",
    platform: asString(properties.platform),
    cloudCover: asNumber(properties["eo:cloud_cover"]),
    orbitState: asString(properties["sat:orbit_state"]),
    polarizations: asStringArray(rawPolarizations),
    resolution: asNumber(properties.gsd),
    bbox,
    assetKeys: Object.entries(feature.assets ?? {})
      .filter(([, asset]) => !asset.roles || asset.roles.some((role) => role === "data" || role === "visual"))
      .map(([key]) => key),
    stacUrl: selfLink,
  };
}

function collectionFor(sensor: SensorId) {
  return sensor === "sentinel-1" ? "sentinel-1-grd" : "sentinel-2-l2a";
}

async function requestPublicStac(sensor: SensorId, request: InvestigationRequest): Promise<CatalogScene[]> {
  const collection = collectionFor(sensor);
  const body: Record<string, unknown> = {
    collections: [collection],
    bbox: request.aoi.bbox,
    datetime: `${request.startDate}T00:00:00Z/${request.endDate}T23:59:59Z`,
    limit: 8,
    sortby: [{ field: "datetime", direction: "desc" }],
  };

  if (request.aoi.geometry) { delete body.bbox; body.intersects = request.aoi.geometry; }
  if (collection === "sentinel-2-l2a") {
    body.query = { "eo:cloud_cover": { lt: 100 } };
  }

  const response = await fetch(CDSE_STAC_SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Copernicus catalogue returned ${response.status}`);
  const payload = await response.json() as StacSearchResponse;
  return (payload.features ?? []).map(normaliseFeature);
}

async function requestBackend(request: InvestigationRequest): Promise<CatalogueSearchResult | null> {
  if (!configuredBackend) return null;
  try {
    const response = await fetch(`${configuredBackend}/api/catalog/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) return null;
    const payload = await response.json() as BackendSearchResponse;
    if (!payload.items) return null;
    return {
      items: payload.items,
      sourceName: payload.source ?? "Copernicus Data Space STAC",
      sourceUrl: CDSE_STAC_SEARCH,
    };
  } catch {
    return null;
  }
}

export async function searchLiveCatalogue(request: InvestigationRequest): Promise<CatalogueSearchResult> {
  const backendResult = await requestBackend(request);
  if (backendResult) return backendResult;

  const selectedSensors: SensorId[] = request.sensors.length > 0 ? request.sensors : ["sentinel-2"];
  const results = await Promise.all(selectedSensors.map((sensor) => requestPublicStac(sensor, request)));
  const items = results.flat().sort((left, right) => Date.parse(right.datetime) - Date.parse(left.datetime));
  return {
    items,
    sourceName: "Copernicus Data Space STAC",
    sourceUrl: CDSE_STAC_SEARCH,
  };
}

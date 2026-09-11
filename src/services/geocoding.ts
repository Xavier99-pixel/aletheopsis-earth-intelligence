import type { AreaOfInterest, BBox } from "../lib/types";

/**
 * Public Nominatim is deliberately used conservatively: the request queue keeps
 * this client below its one-request-per-second public-service limit.  For a
 * production service with substantial traffic, point this module at a hosted
 * geocoding proxy instead.
 */
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const MIN_REQUEST_INTERVAL_MS = 1_100;
const CACHE_TTL_MS = 5 * 60 * 1_000;

type NominatimPlace = {
  place_id?: number | string;
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: unknown;
  category?: string;
  type?: string;
  addresstype?: string;
};

type CacheEntry = {
  expiresAt: number;
  results: LocationSearchResult[];
};

export type LocationSearchResult = AreaOfInterest & {
  id: string;
  label: string;
  category?: string;
  coordinates: readonly [longitude: number, latitude: number];
};

export type GeocodingOptions = {
  signal?: AbortSignal;
  limit?: number;
  language?: string;
};

const cache = new Map<string, CacheEntry>();
let nextRequestStart = 0;

function abortedError() {
  const error = new Error("Location search cancelled.");
  error.name = "AbortError";
  return error;
}

function waitForSlot(signal?: AbortSignal) {
  const now = Date.now();
  const reservedStart = Math.max(now, nextRequestStart);
  nextRequestStart = reservedStart + MIN_REQUEST_INTERVAL_MS;
  const waitMs = reservedStart - now;

  if (signal?.aborted) return Promise.reject(abortedError());
  if (waitMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, lower: number, upper: number) {
  return Math.min(Math.max(value, lower), upper);
}

function pointBounds(longitude: number, latitude: number): BBox {
  // A precise pin still needs a small, queryable AOI for STAC catalogue search.
  const halfSide = 0.0125;
  return [
    clamp(longitude - halfSide, -180, 180),
    clamp(latitude - halfSide, -90, 90),
    clamp(longitude + halfSide, -180, 180),
    clamp(latitude + halfSide, -90, 90),
  ];
}

function toBBox(place: NominatimPlace): BBox | undefined {
  const values = Array.isArray(place.boundingbox)
    ? place.boundingbox.map(numberValue)
    : [];
  if (values.length === 4 && values.every((value): value is number => value !== undefined)) {
    // Nominatim returns [south, north, west, east].
    const [south, north, west, east] = values;
    return [
      clamp(Math.min(west, east), -180, 180),
      clamp(Math.min(south, north), -90, 90),
      clamp(Math.max(west, east), -180, 180),
      clamp(Math.max(south, north), -90, 90),
    ];
  }

  const longitude = numberValue(place.lon);
  const latitude = numberValue(place.lat);
  return longitude === undefined || latitude === undefined ? undefined : pointBounds(longitude, latitude);
}

function normalisePlace(place: NominatimPlace, index: number): LocationSearchResult | undefined {
  const longitude = numberValue(place.lon);
  const latitude = numberValue(place.lat);
  const bbox = toBBox(place);
  const name = place.display_name?.trim();
  if (!name || !bbox || longitude === undefined || latitude === undefined) return undefined;

  return {
    id: String(place.place_id ?? `${longitude}:${latitude}:${index}`),
    name,
    label: name,
    bbox,
    source: "map",
    category: place.addresstype ?? place.category ?? place.type,
    coordinates: [longitude, latitude],
  };
}

/**
 * Finds real-world places with the public OpenStreetMap Nominatim endpoint.
 * Results are intentionally metadata-only; no third-party imagery is copied.
 */
export async function searchLocations(query: string, options: GeocodingOptions = {}): Promise<LocationSearchResult[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (normalizedQuery.length < 2) return [];
  if (options.signal?.aborted) throw abortedError();

  const limit = Math.min(Math.max(Math.round(options.limit ?? 5), 1), 8);
  const language = (options.language ?? navigator.language ?? "en").slice(0, 32);
  const cacheKey = `${normalizedQuery.toLocaleLowerCase()}|${language}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  await waitForSlot(options.signal);
  if (options.signal?.aborted) throw abortedError();

  const params = new URLSearchParams({
    q: normalizedQuery,
    format: "jsonv2",
    limit: String(limit),
    addressdetails: "0",
    namedetails: "0",
    polygon_geojson: "0",
    "accept-language": language,
  });
  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = response.status === 429
      ? "Location search is temporarily rate-limited. Please try again shortly."
      : "Location search is unavailable. Please try again.";
    throw new Error(detail);
  }

  const payload: unknown = await response.json();
  const results = Array.isArray(payload)
    ? payload.map((place, index) => normalisePlace(place as NominatimPlace, index)).filter((place): place is LocationSearchResult => Boolean(place))
    : [];

  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results });
  return results;
}

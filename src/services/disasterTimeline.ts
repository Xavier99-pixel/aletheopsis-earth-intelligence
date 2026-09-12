import type { AreaOfInterest } from "../lib/types";

const EONET_EVENTS = "https://eonet.gsfc.nasa.gov/api/v3/events/geojson";
const EONET_DOCUMENTATION = "https://eonet.gsfc.nasa.gov/docs/v3";
const CACHE_DURATION_MS = 5 * 60 * 1_000;

export type IncidentSeverity = "information" | "watch" | "warning" | "emergency";

export type DisasterTimelineEvent = {
  id: string;
  title: string;
  date: string;
  category: string;
  detail?: string;
  sourceName: string;
  sourceUrl?: string;
  /** The provider applied the selected AOI bounding box and date-window filters. */
  aoiMatched: true;
  severity: IncidentSeverity;
};

export type DisasterTimeline = {
  status: "available" | "limited" | "unavailable";
  providerName: "NASA EONET";
  providerUrl: string;
  queriedRange: { startDate: string; endDate: string };
  events: DisasterTimelineEvent[];
  summary: string;
  note: string;
  fetchedAt: string;
};

type EonetFeature = {
  properties?: {
    id?: string;
    title?: string;
    description?: string | null;
    link?: string;
    date?: string;
    closed?: string | null;
    magnitudeValue?: number | string | null;
    magnitudeUnit?: string | null;
    categories?: Array<{ title?: string }>;
    sources?: Array<{ id?: string; url?: string }>;
  };
};

type EonetResponse = {
  features?: EonetFeature[];
};

const cache = new Map<string, { expiresAt: number; timeline: DisasterTimeline }>();

function dateOnly(value: string) {
  const match = value.match(/^\d{4}-\d{2}-\d{2}$/);
  return match ? value : undefined;
}

function cacheKey(aoi: AreaOfInterest, startDate: string, endDate: string) {
  return `${aoi.bbox.join(",")}|${startDate}|${endDate}`;
}

function toEvent(feature: EonetFeature, index: number): DisasterTimelineEvent | null {
  const properties = feature.properties;
  const title = properties?.title?.trim();
  const date = properties?.date;
  if (!title || !date) return null;
  const category = properties.categories?.map((item) => item.title?.trim()).filter(Boolean).join(", ") || "Recorded event";
  const source = properties.sources?.[0];
  const magnitude = properties.magnitudeValue === null || properties.magnitudeValue === undefined
    ? ""
    : `Magnitude ${properties.magnitudeValue}${properties.magnitudeUnit ? ` ${properties.magnitudeUnit}` : ""}. `;
  const detail = [magnitude, properties.description?.trim() ?? ""].join("").trim() || undefined;
  return {
    id: properties.id || `eonet-${index}`,
    title,
    date,
    category,
    detail,
    sourceName: source?.id || "NASA EONET",
    sourceUrl: source?.url || properties.link,
    aoiMatched: true,
    severity: "information",
  };
}

function makeTimeline(
  status: DisasterTimeline["status"],
  startDate: string,
  endDate: string,
  events: DisasterTimelineEvent[],
  summary: string,
  note: string,
): DisasterTimeline {
  return {
    status,
    providerName: "NASA EONET",
    providerUrl: EONET_DOCUMENTATION,
    queriedRange: { startDate, endDate },
    events,
    summary,
    note,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Queries NASA EONET v3 GeoJSON for recorded public event context inside the
 * selected bounding box and date window. The result is context only: it is not
 * a satellite-derived impact finding and an empty response is never proof that
 * no incident occurred.
 */
export async function loadDisasterTimeline(
  aoi: AreaOfInterest,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<DisasterTimeline> {
  const validStart = dateOnly(startDate);
  const validEnd = dateOnly(endDate);
  if (!validStart || !validEnd || validStart > validEnd) {
    return makeTimeline(
      "unavailable",
      startDate,
      endDate,
      [],
      "Incident timeline could not be queried because the selected date window is invalid.",
      "Choose a valid start date on or before the end date, then run the investigation again.",
    );
  }

  const key = cacheKey(aoi, validStart, validEnd);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.timeline;

  const [west, south, east, north] = aoi.bbox;
  const url = new URL(EONET_EVENTS);
  url.searchParams.set("status", "all");
  url.searchParams.set("start", validStart);
  url.searchParams.set("end", validEnd);
  // EONET uses NW then SE bbox ordering: west,north,east,south.
  url.searchParams.set("bbox", `${west},${north},${east},${south}`);
  url.searchParams.set("limit", "100");

  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      return makeTimeline(
        "limited",
        validStart,
        validEnd,
        [],
        "The public incident timeline is temporarily unavailable.",
        "No incident conclusion is issued while the incident provider is unavailable.",
      );
    }
    const payload = await response.json() as EonetResponse;
    const events = (payload.features ?? [])
      .map(toEvent)
      .filter((event): event is DisasterTimelineEvent => event !== null)
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
    const timeline = makeTimeline(
      "available",
      validStart,
      validEnd,
      events,
      events.length > 0
        ? `${events.length} public incident record${events.length === 1 ? "" : "s"} returned for the selected AOI and time window.`
        : "No public incident records were returned for the selected AOI and time window.",
      events.length > 0
        ? "Incident records are provider-reported context. Verify location, time, and source imagery before treating them as local impact evidence."
        : "An empty public incident result is not evidence that no incident occurred.",
    );
    cache.set(key, { timeline, expiresAt: Date.now() + CACHE_DURATION_MS });
    return timeline;
  } catch {
    return makeTimeline(
      "limited",
      validStart,
      validEnd,
      [],
      "The public incident timeline could not be reached.",
      "No incident conclusion is issued because the provider connection did not complete.",
    );
  }
}

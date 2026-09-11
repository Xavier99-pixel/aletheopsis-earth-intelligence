import type { AreaOfInterest } from "../lib/types";

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

export type RainfallOutlook = {
  source: "Open-Meteo";
  fetchedAt: string;
  startDate?: string;
  endDate?: string;
  totalMillimetres: number;
  peakDailyMillimetres: number;
  peakProbability: number;
  watchLevel: "low" | "watch" | "elevated";
  label: string;
  detail: string;
};

type OpenMeteoPayload = {
  daily?: {
    time?: string[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
  };
};

function centreOf(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  return { latitude: (south + north) / 2, longitude: (west + east) / 2 };
}

function finiteValues(values: unknown): number[] {
  return Array.isArray(values)
    ? values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function classify(totalMillimetres: number, peakDailyMillimetres: number, peakProbability: number): RainfallOutlook["watchLevel"] {
  if (peakDailyMillimetres >= 60 || totalMillimetres >= 120 || (peakDailyMillimetres >= 35 && peakProbability >= 80)) return "elevated";
  if (peakDailyMillimetres >= 20 || totalMillimetres >= 50 || peakProbability >= 70) return "watch";
  return "low";
}

/**
 * Loads a seven-day precipitation outlook for screening only. It is intentionally
 * not a flood model: no river levels, terrain, drainage, exposure, or source-pixel
 * evidence is inferred from this request.
 */
export async function loadRainfallOutlook(aoi: AreaOfInterest, signal?: AbortSignal): Promise<RainfallOutlook | null> {
  const { latitude, longitude } = centreOf(aoi);
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", latitude.toFixed(5));
  url.searchParams.set("longitude", longitude.toFixed(5));
  url.searchParams.set("daily", "precipitation_sum,precipitation_probability_max");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("timezone", "UTC");

  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const payload = await response.json() as OpenMeteoPayload;
    const rainfall = finiteValues(payload.daily?.precipitation_sum);
    const probabilities = finiteValues(payload.daily?.precipitation_probability_max);
    if (rainfall.length === 0) return null;

    const totalMillimetres = round(rainfall.reduce((sum, value) => sum + value, 0));
    const peakDailyMillimetres = round(Math.max(...rainfall));
    const peakProbability = Math.round(Math.max(0, ...probabilities));
    const watchLevel = classify(totalMillimetres, peakDailyMillimetres, peakProbability);
    const dates = payload.daily?.time ?? [];
    const label = watchLevel === "elevated"
      ? "Elevated rainfall watch"
      : watchLevel === "watch"
        ? "Rainfall watch"
        : "Low rainfall signal";

    return {
      source: "Open-Meteo",
      fetchedAt: new Date().toISOString(),
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      totalMillimetres,
      peakDailyMillimetres,
      peakProbability,
      watchLevel,
      label,
      detail: `${totalMillimetres.toFixed(1)} mm forecast rainfall over seven days; peak ${peakDailyMillimetres.toFixed(1)} mm/day with ${peakProbability}% maximum precipitation probability. This is a rainfall screening signal, not a flood prediction.`,
    };
  } catch {
    return null;
  }
}

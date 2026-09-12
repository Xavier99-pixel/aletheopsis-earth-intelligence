import type { AreaOfInterest } from "../lib/types";

const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const FORECAST_HORIZON_DAYS = 15;

export type SelectedWindowWeather = {
  source: "Open-Meteo";
  status: "available" | "limited" | "unavailable";
  coverage: "historical" | "forecast" | "mixed" | "none";
  requestedRange: { startDate: string; endDate: string };
  sampledRange?: { startDate: string; endDate: string };
  dailyObservations: number;
  totalMillimetres: number;
  peakDailyMillimetres: number;
  rainyDays: number;
  heavyRainDays: number;
  label: string;
  detail: string;
  caveat: string;
  fetchedAt: string;
};

type OpenMeteoDailyPayload = {
  daily?: {
    time?: string[];
    precipitation_sum?: number[];
  };
};

type DailyRainfall = { date: string; millimetres: number };

function centreOf(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  return { latitude: (south + north) / 2, longitude: (west + east) / 2 };
}

function localUtcDate(offsetDays = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toISOString().slice(0, 10);
}

function isDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function minDate(left: string, right: string) {
  return left < right ? left : right;
}

function maxDate(left: string, right: string) {
  return left > right ? left : right;
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

async function loadDaily(
  endpoint: string,
  aoi: AreaOfInterest,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<DailyRainfall[]> {
  if (startDate > endDate) return [];
  const { latitude, longitude } = centreOf(aoi);
  const url = new URL(endpoint);
  url.searchParams.set("latitude", latitude.toFixed(5));
  url.searchParams.set("longitude", longitude.toFixed(5));
  url.searchParams.set("daily", "precipitation_sum");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Weather provider returned ${response.status}`);
  const payload = await response.json() as OpenMeteoDailyPayload;
  const dates = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
  const amounts = Array.isArray(payload.daily?.precipitation_sum) ? payload.daily.precipitation_sum : [];
  return dates.flatMap((date, index) => {
    const millimetres = amounts[index];
    return typeof millimetres === "number" && Number.isFinite(millimetres) ? [{ date, millimetres }] : [];
  });
}

function unavailable(startDate: string, endDate: string, detail: string): SelectedWindowWeather {
  return {
    source: "Open-Meteo",
    status: "unavailable",
    coverage: "none",
    requestedRange: { startDate, endDate },
    dailyObservations: 0,
    totalMillimetres: 0,
    peakDailyMillimetres: 0,
    rainyDays: 0,
    heavyRainDays: 0,
    label: "Selected-window rainfall context unavailable",
    detail,
    caveat: "No rainfall, flood, damage, or exposure conclusion is issued without a returned provider record and a validated risk model.",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Loads daily precipitation facts for the exact selected window where public
 * coverage exists. Historical and future values are intentionally separated:
 * historical values are context, while future values are a weather forecast,
 * never a flood or damage prediction.
 */
export async function loadSelectedWindowWeather(
  aoi: AreaOfInterest,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<SelectedWindowWeather> {
  if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) {
    return unavailable(startDate, endDate, "Choose a valid start date on or before the end date.");
  }

  const today = localUtcDate();
  const yesterday = localUtcDate(-1);
  const maximumForecastDate = localUtcDate(FORECAST_HORIZON_DAYS);
  const historicalRange = startDate <= yesterday
    ? { startDate, endDate: minDate(endDate, yesterday) }
    : null;
  const forecastRange = endDate >= today && startDate <= maximumForecastDate
    ? { startDate: maxDate(startDate, today), endDate: minDate(endDate, maximumForecastDate) }
    : null;

  const tasks: Array<Promise<{ kind: "historical" | "forecast"; values: DailyRainfall[] }>> = [];
  if (historicalRange) {
    tasks.push(loadDaily(OPEN_METEO_ARCHIVE, aoi, historicalRange.startDate, historicalRange.endDate, signal)
      .then((values) => ({ kind: "historical" as const, values })));
  }
  if (forecastRange) {
    tasks.push(loadDaily(OPEN_METEO_FORECAST, aoi, forecastRange.startDate, forecastRange.endDate, signal)
      .then((values) => ({ kind: "forecast" as const, values })));
  }
  if (tasks.length === 0) {
    return unavailable(
      startDate,
      endDate,
      `The provider offers forecasts only through ${maximumForecastDate}; no usable public daily-precipitation coverage was selected for this range.`,
    );
  }

  const settled = await Promise.allSettled(tasks);
  const successes = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const coverageKinds = successes.filter((result) => result.values.length > 0).map((result) => result.kind);
  const dailyByDate = new Map<string, number>();
  successes.flatMap((result) => result.values).forEach(({ date, millimetres }) => dailyByDate.set(date, millimetres));
  const daily = [...dailyByDate.entries()]
    .map(([date, millimetres]) => ({ date, millimetres }))
    .sort((left, right) => left.date.localeCompare(right.date));

  if (daily.length === 0) {
    return unavailable(startDate, endDate, "The public weather provider returned no usable daily-precipitation values for the selected range.");
  }

  const coverage: SelectedWindowWeather["coverage"] = coverageKinds.includes("historical") && coverageKinds.includes("forecast")
    ? "mixed"
    : coverageKinds.includes("forecast")
      ? "forecast"
      : "historical";
  const totalMillimetres = round(daily.reduce((total, item) => total + item.millimetres, 0));
  const peakDailyMillimetres = round(Math.max(...daily.map((item) => item.millimetres)));
  const rainyDays = daily.filter((item) => item.millimetres >= 1).length;
  const heavyRainDays = daily.filter((item) => item.millimetres >= 20).length;
  const partial = settled.some((result) => result.status === "rejected");
  const prefix = coverage === "forecast"
    ? "Selected-window rainfall outlook"
    : coverage === "historical"
      ? "Recorded rainfall context"
      : "Historical + forecast rainfall context";
  const qualifier = coverage === "forecast"
    ? "Forecast daily precipitation"
    : coverage === "historical"
      ? "Historical daily precipitation"
      : "Historical and forecast daily precipitation";
  return {
    source: "Open-Meteo",
    status: partial ? "limited" : "available",
    coverage,
    requestedRange: { startDate, endDate },
    sampledRange: { startDate: daily[0].date, endDate: daily[daily.length - 1].date },
    dailyObservations: daily.length,
    totalMillimetres,
    peakDailyMillimetres,
    rainyDays,
    heavyRainDays,
    label: prefix,
    detail: `${qualifier} for ${daily[0].date} to ${daily[daily.length - 1].date}: ${totalMillimetres.toFixed(1)} mm total, ${peakDailyMillimetres.toFixed(1)} mm peak day, ${rainyDays} day${rainyDays === 1 ? "" : "s"} with at least 1 mm, and ${heavyRainDays} day${heavyRainDays === 1 ? "" : "s"} with at least 20 mm.${partial ? " One requested provider segment was unavailable." : ""}`,
    caveat: coverage === "forecast"
      ? "This is a weather forecast for the selected date window, not a flood, landslide, damage, or exposure prediction."
      : "Historical rainfall is context only; a future flood or impact claim requires a calibrated model with terrain, drainage, exposure, and observed conditions.",
    fetchedAt: new Date().toISOString(),
  };
}

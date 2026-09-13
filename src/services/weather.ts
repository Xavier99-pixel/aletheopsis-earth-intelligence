import type { AreaOfInterest } from "../lib/types";

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const NASA_POWER_CLIMATOLOGY = "https://power.larc.nasa.gov/api/temporal/climatology/point";
const WEATHER_CACHE_MS = 10 * 60 * 1_000;
const RECENT_RAIN_DAYS = 30;

export type WeatherWatchLevel = "low" | "watch" | "elevated";

export type ForecastDay = {
  date: string;
  precipitationMillimetres: number;
  precipitationProbability: number;
  temperatureMinimumCelsius?: number;
  temperatureMaximumCelsius?: number;
  windMaximumKilometresPerHour?: number;
  weatherCode?: number;
  condition: string;
};

export type CurrentConditions = {
  observedAt?: string;
  temperatureCelsius?: number;
  humidityPercent?: number;
  precipitationMillimetres?: number;
  windKilometresPerHour?: number;
  weatherCode?: number;
  condition: string;
};

export type RecentRainfallPattern = {
  startDate: string;
  endDate: string;
  sampledDays: number;
  totalMillimetres: number;
  peakDailyMillimetres: number;
  rainyDays: number;
};

export type ClimatePattern = {
  month: string;
  baseline: string;
  meanDailyPrecipitationMillimetres: number;
  estimatedMonthlyPrecipitationMillimetres: number;
  meanTemperatureCelsius: number;
};

export type WeatherProvenance = {
  id: "forecast" | "recent-rainfall" | "climate-baseline";
  product: string;
  role: string;
  retrievedAt: string;
};

/**
 * A live, coordinate-specific atmospheric assessment. Forecast values are
 * weather-model output, recent values are a returned daily record, and the
 * climate field is a long-term monthly baseline. None of these is a flood,
 * landslide, damage, or exposure prediction.
 */
export type RainfallOutlook = {
  /** Product-facing label; provenance remains in the structured record. */
  source: "Atmospheric intelligence";
  fetchedAt: string;
  locationTimezone?: string;
  startDate?: string;
  endDate?: string;
  totalMillimetres: number;
  peakDailyMillimetres: number;
  peakProbability: number;
  watchLevel: WeatherWatchLevel;
  label: string;
  detail: string;
  current?: CurrentConditions;
  dailyForecast: ForecastDay[];
  recentRainfall?: RecentRainfallPattern;
  climatePattern?: ClimatePattern;
  provenance: WeatherProvenance[];
  caveat: string;
};

type OpenMeteoForecastPayload = {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    wind_speed_10m_max?: number[];
    weather_code?: number[];
  };
};

type OpenMeteoArchivePayload = {
  daily?: {
    time?: string[];
    precipitation_sum?: number[];
  };
};

type NasaPowerPayload = {
  properties?: {
    parameter?: {
      PRECTOTCORR?: Record<string, number>;
      T2M?: Record<string, number>;
    };
  };
  header?: { range?: string };
};

type CacheEntry = { expiresAt: number; outlook: RainfallOutlook };

const cache = new Map<string, CacheEntry>();
const WEATHER_TERMS = /\b(weather|rain|rainfall|precipitation|monsoon|climate|temperature|humidity|wind|storm|heat|cold|forecast)\b/i;
const MONTH_KEYS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function centreOf(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  return { latitude: (south + north) / 2, longitude: (west + east) / 2 };
}

function cacheKey(aoi: AreaOfInterest) {
  const { latitude, longitude } = centreOf(aoi);
  return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

function numberAt(values: unknown, index: number): number | undefined {
  const value = Array.isArray(values) ? values[index] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function dateUtc(daysFromToday: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

function conditionFor(code: number | undefined) {
  if (code === undefined) return "Condition not classified";
  if (code === 0) return "Clear sky";
  if ([1, 2, 3].includes(code)) return "Partly cloudy";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Mixed conditions";
}

function classify(totalMillimetres: number, peakDailyMillimetres: number, peakProbability: number): WeatherWatchLevel {
  if (peakDailyMillimetres >= 60 || totalMillimetres >= 120 || (peakDailyMillimetres >= 35 && peakProbability >= 80)) return "elevated";
  if (peakDailyMillimetres >= 20 || totalMillimetres >= 50 || peakProbability >= 70) return "watch";
  return "low";
}

function labelFor(level: WeatherWatchLevel) {
  if (level === "elevated") return "Elevated rainfall outlook";
  if (level === "watch") return "Rainfall watch";
  return "Low rainfall outlook";
}

function safeNumber(value: number | undefined, fallback = 0) {
  return value === undefined ? fallback : value;
}

function buildForecastDays(payload: OpenMeteoForecastPayload): ForecastDay[] {
  const dates = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
  return dates.flatMap((date, index) => {
    const precipitationMillimetres = numberAt(payload.daily?.precipitation_sum, index);
    if (!date || precipitationMillimetres === undefined) return [];
    const weatherCode = numberAt(payload.daily?.weather_code, index);
    return [{
      date,
      precipitationMillimetres: round(precipitationMillimetres),
      precipitationProbability: Math.round(safeNumber(numberAt(payload.daily?.precipitation_probability_max, index))),
      temperatureMinimumCelsius: finite(numberAt(payload.daily?.temperature_2m_min, index)),
      temperatureMaximumCelsius: finite(numberAt(payload.daily?.temperature_2m_max, index)),
      windMaximumKilometresPerHour: finite(numberAt(payload.daily?.wind_speed_10m_max, index)),
      weatherCode,
      condition: conditionFor(weatherCode),
    }];
  });
}

function currentConditions(payload: OpenMeteoForecastPayload): CurrentConditions | undefined {
  const current = payload.current;
  if (!current) return undefined;
  const weatherCode = finite(current.weather_code);
  const hasValue = [current.temperature_2m, current.relative_humidity_2m, current.precipitation, current.wind_speed_10m, weatherCode]
    .some((value) => finite(value) !== undefined);
  if (!hasValue) return undefined;
  return {
    observedAt: current.time,
    temperatureCelsius: finite(current.temperature_2m),
    humidityPercent: finite(current.relative_humidity_2m),
    precipitationMillimetres: finite(current.precipitation),
    windKilometresPerHour: finite(current.wind_speed_10m),
    weatherCode,
    condition: conditionFor(weatherCode),
  };
}

async function fetchForecast(aoi: AreaOfInterest, signal?: AbortSignal): Promise<{ payload: OpenMeteoForecastPayload; days: ForecastDay[] }> {
  const { latitude, longitude } = centreOf(aoi);
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", latitude.toFixed(5));
  url.searchParams.set("longitude", longitude.toFixed(5));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "precipitation_sum,precipitation_probability_max,temperature_2m_min,temperature_2m_max,wind_speed_10m_max,weather_code");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("timezone", "auto");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Forecast service returned ${response.status}`);
  const payload = await response.json() as OpenMeteoForecastPayload;
  const days = buildForecastDays(payload);
  if (days.length === 0) throw new Error("Forecast service returned no usable daily values");
  return { payload, days };
}

async function fetchRecentRainfall(aoi: AreaOfInterest, signal?: AbortSignal): Promise<RecentRainfallPattern | undefined> {
  const { latitude, longitude } = centreOf(aoi);
  const endDate = dateUtc(-1);
  const startDate = dateUtc(-RECENT_RAIN_DAYS);
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set("latitude", latitude.toFixed(5));
  url.searchParams.set("longitude", longitude.toFixed(5));
  url.searchParams.set("daily", "precipitation_sum");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("timezone", "auto");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Recent-rainfall service returned ${response.status}`);
  const payload = await response.json() as OpenMeteoArchivePayload;
  const dates = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
  const values = dates.flatMap((date, index) => {
    const millimetres = numberAt(payload.daily?.precipitation_sum, index);
    return date && millimetres !== undefined ? [{ date, millimetres }] : [];
  });
  if (values.length === 0) return undefined;
  return {
    startDate: values[0].date,
    endDate: values[values.length - 1].date,
    sampledDays: values.length,
    totalMillimetres: round(values.reduce((total, value) => total + value.millimetres, 0)),
    peakDailyMillimetres: round(Math.max(...values.map((value) => value.millimetres))),
    rainyDays: values.filter((value) => value.millimetres >= 1).length,
  };
}

async function fetchClimatePattern(aoi: AreaOfInterest, signal?: AbortSignal): Promise<ClimatePattern | undefined> {
  const { latitude, longitude } = centreOf(aoi);
  const url = new URL(NASA_POWER_CLIMATOLOGY);
  url.searchParams.set("parameters", "PRECTOTCORR,T2M");
  url.searchParams.set("community", "AG");
  url.searchParams.set("longitude", longitude.toFixed(5));
  url.searchParams.set("latitude", latitude.toFixed(5));
  url.searchParams.set("format", "JSON");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Climate baseline service returned ${response.status}`);
  const payload = await response.json() as NasaPowerPayload;
  const monthIndex = new Date().getUTCMonth();
  const key = MONTH_KEYS[monthIndex];
  const precipitation = finite(payload.properties?.parameter?.PRECTOTCORR?.[key]);
  const temperature = finite(payload.properties?.parameter?.T2M?.[key]);
  if (precipitation === undefined || precipitation < 0 || temperature === undefined || temperature < -100) return undefined;
  const year = new Date().getUTCFullYear();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const month = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthIndex, 1)));
  return {
    month,
    baseline: payload.header?.range?.slice(0, 140) || "Long-term monthly climatology",
    meanDailyPrecipitationMillimetres: round(precipitation),
    estimatedMonthlyPrecipitationMillimetres: round(precipitation * daysInMonth),
    meanTemperatureCelsius: round(temperature),
  };
}

function forecastDetail(days: readonly ForecastDay[], total: number, peak: number, probability: number) {
  const wettest = [...days].sort((left, right) => right.precipitationMillimetres - left.precipitationMillimetres)[0];
  const wettestText = wettest && wettest.precipitationMillimetres > 0
    ? ` Wettest forecast day: ${wettest.date}, ${wettest.precipitationMillimetres.toFixed(1)} mm (${wettest.precipitationProbability}% probability).`
    : " No measurable daily rainfall is currently forecast.";
  return `${total.toFixed(1)} mm forecast rainfall over ${days.length} days; peak ${peak.toFixed(1)} mm/day and ${probability}% maximum precipitation probability.${wettestText}`;
}

/** Returns true for natural-language questions that require atmospheric data. */
export function isWeatherQuestion(question: string) {
  return WEATHER_TERMS.test(question);
}

/**
 * Loads current atmospheric conditions, a seven-day forecast, a recent
 * precipitation record, and a monthly climate baseline for the selected AOI.
 * A forecast response is required; supporting historical/climate records can
 * fail independently without suppressing the live forecast.
 */
export async function loadRainfallOutlook(aoi: AreaOfInterest, signal?: AbortSignal): Promise<RainfallOutlook | null> {
  const key = cacheKey(aoi);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.outlook;

  const [forecastResult, recentResult, climateResult] = await Promise.allSettled([
    fetchForecast(aoi, signal),
    fetchRecentRainfall(aoi, signal),
    fetchClimatePattern(aoi, signal),
  ]);
  if (forecastResult.status !== "fulfilled") return null;

  const { payload, days } = forecastResult.value;
  const totalMillimetres = round(days.reduce((sum, day) => sum + day.precipitationMillimetres, 0));
  const peakDailyMillimetres = round(Math.max(...days.map((day) => day.precipitationMillimetres)));
  const peakProbability = Math.max(...days.map((day) => day.precipitationProbability));
  const watchLevel = classify(totalMillimetres, peakDailyMillimetres, peakProbability);
  const fetchedAt = new Date().toISOString();
  const recentRainfall = recentResult.status === "fulfilled" ? recentResult.value : undefined;
  const climatePattern = climateResult.status === "fulfilled" ? climateResult.value : undefined;
  const provenance: WeatherProvenance[] = [{
    id: "forecast",
    product: "Global atmospheric forecast fields",
    role: "Current conditions and seven-day weather outlook",
    retrievedAt: fetchedAt,
  }];
  if (recentRainfall) {
    provenance.push({
      id: "recent-rainfall",
      product: "Daily precipitation record",
      role: "Recent rainfall pattern",
      retrievedAt: fetchedAt,
    });
  }
  if (climatePattern) {
    provenance.push({
      id: "climate-baseline",
      product: "NASA POWER monthly climatology",
      role: "Long-term climate baseline",
      retrievedAt: fetchedAt,
    });
  }
  const outlook: RainfallOutlook = {
    source: "Atmospheric intelligence",
    fetchedAt,
    locationTimezone: payload.timezone,
    startDate: days[0]?.date,
    endDate: days[days.length - 1]?.date,
    totalMillimetres,
    peakDailyMillimetres,
    peakProbability,
    watchLevel,
    label: labelFor(watchLevel),
    detail: forecastDetail(days, totalMillimetres, peakDailyMillimetres, peakProbability),
    current: currentConditions(payload),
    dailyForecast: days,
    recentRainfall,
    climatePattern,
    provenance,
    caveat: "Weather forecast and climate context are not a flood, landslide, damage, crop-loss, or exposure prediction. Those claims require validated local inputs and a calibrated model.",
  };
  cache.set(key, { outlook, expiresAt: Date.now() + WEATHER_CACHE_MS });
  return outlook;
}

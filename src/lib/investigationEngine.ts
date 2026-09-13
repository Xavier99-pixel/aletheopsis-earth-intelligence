import type { AreaOfInterest, BBox, CatalogScene, InvestigationRequest, SensorId } from "./types";

/**
 * A deliberately evidence-first language layer for the investigation workspace.
 *
 * It is pure: it makes no network calls, does not inspect pixels, and never turns
 * catalogue metadata into a flood/change/object claim. Pass `generatedAt` while
 * testing to make freshness calculations fully deterministic.
 */

const EARTH_MEAN_RADIUS_METRES = 6_371_008.8;

export type InvestigationIntent = "flood" | "vegetation" | "change" | "measure" | "objects" | "general";

export type InvestigationStepState = "complete" | "ready" | "needs-imagery" | "withheld";

export type BBoxGeodesicMeasurement = {
  areaSquareKilometres: number;
  perimeterKilometres: number;
  northEdgeKilometres: number;
  southEdgeKilometres: number;
  eastEdgeKilometres: number;
  westEdgeKilometres: number;
  latitudeSpanDegrees: number;
  longitudeSpanDegrees: number;
  formattedArea: string;
  formattedPerimeter: string;
  method: string;
};

export type CatalogueFreshness = "current" | "recent" | "aging" | "historical" | "unknown";

export type CatalogueMetrics = {
  totalScenes: number;
  opticalScenes: number;
  sarScenes: number;
  scenesWithValidTime: number;
  earliestAcquisition?: string;
  latestAcquisition?: string;
  latestAgeHours?: number;
  freshness: CatalogueFreshness;
  opticalScenesWithCloudMetric: number;
  latestOpticalCloudCover?: number;
  meanOpticalCloudCover?: number;
  lowestOpticalCloudCover?: number;
};

export type InvestigationEvidence = {
  kind: "geometry" | "catalogue" | "quality" | "withheld";
  label: string;
  value: string;
  sourceSceneId?: string;
};

export type InvestigationStep = {
  id: string;
  label: string;
  state: InvestigationStepState;
  detail: string;
  requiredSensors: SensorId[];
};

export type InvestigationPlan = {
  intents: InvestigationIntent[];
  predictiveQuestion: boolean;
  selectedSensors: SensorId[];
  recommendedSensors: SensorId[];
  steps: InvestigationStep[];
};

export type AnalysisModuleId = "measure" | "vegetation" | "change" | "flood" | "objects";

export type AnalysisModuleState = "computed" | "ready-for-processing" | "awaiting-source" | "needs-authorised-imagery";

/**
 * Evidence-aware module metadata. A ready module is not a completed analysis:
 * it means the catalogue supplied a plausible starting asset for a documented
 * processing job.
 */
export type AnalysisModuleReadiness = {
  id: AnalysisModuleId;
  label: string;
  state: AnalysisModuleState;
  stateLabel: string;
  output: string;
  evidence: string;
  method: string;
  sourceSceneIds: string[];
};

export type InvestigationBrief = {
  question: string;
  naturalLanguageSummary: string;
  descriptiveResponse: string;
  predictiveResponse: string;
  claimStatus: "catalogue-and-geometry-only" | "no-catalogue-evidence";
  measurements: BBoxGeodesicMeasurement;
  catalogue: CatalogueMetrics;
  plan: InvestigationPlan;
  analysisReadiness: AnalysisModuleReadiness[];
  evidence: InvestigationEvidence[];
  caveats: string[];
  generatedAt: string;
};

export type InvestigationEngineOptions = {
  /** Supply this in tests or server jobs to make catalogue freshness reproducible. */
  generatedAt?: Date;
};

type IntentRule = {
  intent: Exclude<InvestigationIntent, "general">;
  matches: RegExp;
};

const INTENT_RULES: IntentRule[] = [
  { intent: "flood", matches: /\bflood(?:ed|ing)?\b|\binundat(?:e|ed|ion)\b|\bwaterlog(?:ged|ging)?\b|\bstanding water\b|\bwater extent\b/i },
  { intent: "vegetation", matches: /\bvegetation\b|\bndvi\b|\bcrop(?:s| health| stress)?\b|\bforest\b|\bgreenness\b|\bcanopy\b|\bdrought\b|\bagricultur(?:e|al)\b/i },
  { intent: "change", matches: /\bchange\b|\bcompare\b|\bbefore and after\b|\bencroach(?:ment)?\b|\bconstruction\b|\bexpansion\b|\bloss\b|\bgrowth\b|\btemporal\b/i },
  { intent: "measure", matches: /\bmeasure\b|\bperimeter\b|\bdistance\b|\bhow (?:large|big|much land)\b|\barea (?:of|is|does|measure)\b|\bwhat (?:is|is the) (?:area|size)\b|\bextent\b/i },
  { intent: "objects", matches: /\bobject(?:s)?\b|\bcount\b|\bbuildings?\b|\broads?\b|\bvehicles?\b|\btrees?\b|\bsegment(?:ation)?\b|\bhouses?\b/i },
];

const PREDICTIVE_LANGUAGE = /\bpredict(?:ion|ive)?\b|\bforecast\b|\bexpect(?:ed|ation)?\b|\brisk\b|\blikely\b|\bfuture\b|\bwill\b/i;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

function radians(degrees: number) {
  return degrees * (Math.PI / 180);
}

function round(value: number, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function formatQuantity(value: number, unit: string) {
  return `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(round(value))} ${unit}`;
}

function normaliseLongitude(value: number) {
  const normalised = ((value + 180) % 360 + 360) % 360 - 180;
  return normalised === -180 && value > 0 ? 180 : normalised;
}

function longitudeSpanDegrees(west: number, east: number, rawWest: number, rawEast: number) {
  const rawSpan = Math.abs(rawEast - rawWest);
  if (rawSpan >= 359.999) return 360;
  return east >= west ? east - west : east + 360 - west;
}

/** Great-circle distance between two latitude/longitude coordinates in kilometres. */
function greatCircleKilometres(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const sinLatitude = Math.sin(deltaLatitude / 2);
  const sinLongitude = Math.sin(deltaLongitude / 2);
  const haversine = sinLatitude ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * sinLongitude ** 2;
  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
  return (EARTH_MEAN_RADIUS_METRES * angularDistance) / 1_000;
}

/**
 * Computes a repeatable spherical-Earth estimate for a rectangular WGS84 bbox.
 * Use PostGIS/ST_Area on an AOI polygon for a legally surveyed or complex boundary.
 */
export function calculateBBoxGeodesics(bbox: BBox): BBoxGeodesicMeasurement {
  const [rawWest, rawSouth, rawEast, rawNorth] = bbox;
  const west = normaliseLongitude(finite(rawWest));
  const east = normaliseLongitude(finite(rawEast));
  const south = clamp(Math.min(finite(rawSouth), finite(rawNorth)), -90, 90);
  const north = clamp(Math.max(finite(rawSouth), finite(rawNorth)), -90, 90);
  const longitudeSpan = clamp(longitudeSpanDegrees(west, east, rawWest, rawEast), 0, 360);
  const latitudeSpan = north - south;
  const longitudeRadians = radians(longitudeSpan);

  // Surface area of a latitude/longitude rectangle on a sphere.
  const areaSquareKilometres = Math.abs(
    EARTH_MEAN_RADIUS_METRES ** 2
      * longitudeRadians
      * (Math.sin(radians(north)) - Math.sin(radians(south))),
  ) / 1_000_000;

  // BBoxes used by the UI are local. For an antimeridian/global AOI, this still
  // stays deterministic, while a stored polygon should be measured in PostGIS.
  const eastForDistance = west + longitudeSpan;
  const northEdgeKilometres = greatCircleKilometres(north, west, north, eastForDistance);
  const southEdgeKilometres = greatCircleKilometres(south, west, south, eastForDistance);
  const westEdgeKilometres = greatCircleKilometres(south, west, north, west);
  const eastEdgeKilometres = greatCircleKilometres(south, eastForDistance, north, eastForDistance);
  const perimeterKilometres = northEdgeKilometres + southEdgeKilometres + eastEdgeKilometres + westEdgeKilometres;

  return {
    areaSquareKilometres: round(areaSquareKilometres),
    perimeterKilometres: round(perimeterKilometres),
    northEdgeKilometres: round(northEdgeKilometres),
    southEdgeKilometres: round(southEdgeKilometres),
    eastEdgeKilometres: round(eastEdgeKilometres),
    westEdgeKilometres: round(westEdgeKilometres),
    latitudeSpanDegrees: round(latitudeSpan, 6),
    longitudeSpanDegrees: round(longitudeSpan, 6),
    formattedArea: formatQuantity(areaSquareKilometres, "km²"),
    formattedPerimeter: formatQuantity(perimeterKilometres, "km"),
    method: "Spherical-Earth bounding-box estimate (mean Earth radius); not a surveyed polygon measurement.",
  };
}

function parsedDate(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function sortScenesByNewest(scenes: readonly CatalogScene[]) {
  return [...scenes].sort((left, right) => (parsedDate(right.datetime) ?? -Infinity) - (parsedDate(left.datetime) ?? -Infinity));
}

function freshnessForAge(ageHours: number | undefined): CatalogueFreshness {
  if (ageHours === undefined) return "unknown";
  if (ageHours <= 72) return "current";
  if (ageHours <= 14 * 24) return "recent";
  if (ageHours <= 60 * 24) return "aging";
  return "historical";
}

/** Derives facts from STAC metadata only; it deliberately does not inspect imagery pixels. */
export function deriveCatalogueMetrics(scenes: readonly CatalogScene[], generatedAt: Date): CatalogueMetrics {
  const ordered = sortScenesByNewest(scenes);
  const timedScenes = ordered.filter((scene) => parsedDate(scene.datetime) !== undefined);
  const optical = ordered.filter((scene) => scene.collection === "sentinel-2-l2a");
  const sar = ordered.filter((scene) => scene.collection === "sentinel-1-grd");
  const opticalCloudValues = optical
    .map((scene) => scene.cloudCover)
    .filter((cloudCover): cloudCover is number => typeof cloudCover === "number" && Number.isFinite(cloudCover));
  const latestTimed = timedScenes[0];
  const earliestTimed = timedScenes[timedScenes.length - 1];
  const latestTime = latestTimed ? parsedDate(latestTimed.datetime) : undefined;
  const ageHours = latestTime === undefined
    ? undefined
    : Math.max(0, (generatedAt.getTime() - latestTime) / (60 * 60 * 1_000));
  const latestOptical = optical.find((scene) => parsedDate(scene.datetime) !== undefined) ?? optical[0];

  return {
    totalScenes: scenes.length,
    opticalScenes: optical.length,
    sarScenes: sar.length,
    scenesWithValidTime: timedScenes.length,
    earliestAcquisition: earliestTimed?.datetime,
    latestAcquisition: latestTimed?.datetime,
    latestAgeHours: ageHours === undefined ? undefined : round(ageHours, 1),
    freshness: freshnessForAge(ageHours),
    opticalScenesWithCloudMetric: opticalCloudValues.length,
    latestOpticalCloudCover: latestOptical?.cloudCover === undefined ? undefined : round(latestOptical.cloudCover, 1),
    meanOpticalCloudCover: opticalCloudValues.length === 0
      ? undefined
      : round(opticalCloudValues.reduce((total, cloudCover) => total + cloudCover, 0) / opticalCloudValues.length, 1),
    lowestOpticalCloudCover: opticalCloudValues.length === 0 ? undefined : round(Math.min(...opticalCloudValues), 1),
  };
}

export function detectInvestigationIntents(question: string): InvestigationIntent[] {
  const detected = INTENT_RULES
    .filter((rule) => rule.matches.test(question))
    .map((rule) => rule.intent);
  return detected.length > 0 ? [...new Set(detected)] : ["general"];
}

function preferredSensorsFor(intents: InvestigationIntent[]): SensorId[] {
  const sensors = new Set<SensorId>();
  if (intents.includes("flood")) {
    sensors.add("sentinel-1");
    sensors.add("sentinel-2");
  }
  if (intents.includes("vegetation")) sensors.add("sentinel-2");
  if (intents.includes("change")) {
    sensors.add("sentinel-2");
    sensors.add("sentinel-1");
  }
  if (intents.includes("objects")) sensors.add("sentinel-2");
  return [...sensors];
}

function intentName(intent: InvestigationIntent) {
  if (intent === "flood") return "flood screening";
  if (intent === "vegetation") return "vegetation condition";
  if (intent === "change") return "temporal change";
  if (intent === "measure") return "geospatial measurement";
  if (intent === "objects") return "object/feature identification";
  return "an evidence-backed Earth observation review";
}

function descriptiveClaimFor(intents: InvestigationIntent[], measurements: BBoxGeodesicMeasurement) {
  const claims: string[] = [];
  if (intents.includes("measure")) {
    claims.push(`The selected bounding box is ${measurements.formattedArea} with an estimated ${measurements.formattedPerimeter} perimeter.`);
  }
  if (intents.includes("flood")) {
    claims.push("No flood extent is issued from catalogue metadata alone; a SAR/optical pixel workflow and quality review are still required.");
  }
  if (intents.includes("vegetation")) {
    claims.push("No NDVI or crop-condition value is issued until a cloud-screened optical image is processed.");
  }
  if (intents.includes("change")) {
    claims.push("No change claim is issued until two registered, quality-checked acquisitions are compared.");
  }
  if (intents.includes("objects")) {
    claims.push("No object count is issued until a validated segmentation model has processed suitable source imagery.");
  }
  if (claims.length === 0) {
    claims.push("The current response is limited to the requested AOI geometry and catalogue evidence; no source pixels have been analysed yet.");
  }
  return claims.join(" ");
}

function intentProcessingDetail(intents: InvestigationIntent[]) {
  if (intents.includes("flood")) return "Run a documented SAR water-detection workflow, cross-check it with cloud-screened optical imagery where available, then validate the classified boundary.";
  if (intents.includes("vegetation")) return "Run a cloud-mask and an optical vegetation-index workflow, then preserve the raster, parameters, and date as evidence.";
  if (intents.includes("change")) return "Register comparable acquisitions, normalise the sensor-specific inputs, then compute and review a change layer.";
  if (intents.includes("objects")) return "Select suitable-resolution imagery, run the versioned segmentation model, and retain every derived polygon with its source scene.";
  return "Select a source acquisition, define the requested GIS operation, and preserve the result with its source scene and parameters.";
}

function buildPlan(request: InvestigationRequest, intents: InvestigationIntent[], scenes: readonly CatalogScene[], measurements: BBoxGeodesicMeasurement): InvestigationPlan {
  const recommendedSensors = preferredSensorsFor(intents);
  const sensorsToUse = recommendedSensors.length > 0 ? recommendedSensors : request.sensors;
  const requiresPixels = intents.some((intent) => intent !== "measure" && intent !== "general");
  const missingRecommended = recommendedSensors.filter((sensor) => !request.sensors.includes(sensor));
  const completeGeometry = `Computed ${measurements.formattedArea} and ${measurements.formattedPerimeter} from the current bounding box.`;

  return {
    intents,
    predictiveQuestion: PREDICTIVE_LANGUAGE.test(request.question),
    selectedSensors: request.sensors,
    recommendedSensors,
    steps: [
      {
        id: "aoi-geometry",
        label: "Establish AOI geometry",
        state: "complete",
        detail: completeGeometry,
        requiredSensors: [],
      },
      {
        id: "catalogue-evidence",
        label: "Check source acquisitions",
        state: scenes.length > 0 ? "complete" : "ready",
        detail: scenes.length > 0
          ? `${scenes.length} catalogue scene${scenes.length === 1 ? "" : "s"} are available for review.`
          : "No scenes were returned. Widen the date range or adjust the AOI before processing.",
        requiredSensors: sensorsToUse,
      },
      {
        id: "source-pixel-analysis",
        label: "Run source-pixel analysis",
        state: requiresPixels && scenes.length > 0 ? "needs-imagery" : "ready",
        detail: missingRecommended.length > 0
          ? `Add ${missingRecommended.join(" and ")} for the recommended evidence route. ${intentProcessingDetail(intents)}`
          : intentProcessingDetail(intents),
        requiredSensors: sensorsToUse,
      },
      {
        id: "verify-claim",
        label: "Verify and issue a claim",
        state: requiresPixels ? "withheld" : "ready",
        detail: requiresPixels
          ? "Withhold descriptive or predictive claims until source pixels, quality checks, processing parameters, and independent evidence are recorded."
          : "The geometry result can be reported with the stated bounding-box measurement method.",
        requiredSensors: sensorsToUse,
      },
    ],
  };
}

function dateLabel(value: string | undefined) {
  if (!value) return "not available";
  const milliseconds = parsedDate(value);
  if (milliseconds === undefined) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(milliseconds));
}

function latestSceneIds(scenes: readonly CatalogScene[], collection?: CatalogScene["collection"], maximum = 2) {
  return sortScenesByNewest(scenes)
    .filter((scene) => !collection || scene.collection === collection)
    .slice(0, maximum)
    .map((scene) => scene.id);
}

function readinessState(hasUsableSource: boolean): Pick<AnalysisModuleReadiness, "state" | "stateLabel"> {
  return hasUsableSource
    ? { state: "ready-for-processing", stateLabel: "Ready for processing" }
    : { state: "awaiting-source", stateLabel: "Awaiting suitable source" };
}

/**
 * Converts real catalogue metadata into honest module readiness records.
 * These records intentionally never contain invented NDVI, flood-area, change
 * area, or object-count values.
 */
function buildAnalysisReadiness(
  measurements: BBoxGeodesicMeasurement,
  metrics: CatalogueMetrics,
  scenes: readonly CatalogScene[],
): AnalysisModuleReadiness[] {
  const opticalIds = latestSceneIds(scenes, "sentinel-2-l2a");
  const sarIds = latestSceneIds(scenes, "sentinel-1-grd");
  const anyIds = latestSceneIds(scenes);
  const vegetationReady = opticalIds.length > 0;
  const changeReady = scenes.length >= 2;
  const floodReady = sarIds.length > 0;

  return [
    {
      id: "measure",
      label: "Measure",
      state: "computed",
      stateLabel: "Computed",
      output: `${measurements.formattedArea} · ${measurements.formattedPerimeter}`,
      evidence: "Current AOI bounding-box geometry",
      method: measurements.method,
      sourceSceneIds: [],
    },
    {
      id: "vegetation",
      label: "Vegetation",
      ...readinessState(vegetationReady),
      output: "NDVI / vegetation condition not computed",
      evidence: vegetationReady
        ? `${metrics.opticalScenes} optical scene${metrics.opticalScenes === 1 ? "" : "s"} catalogued${metrics.lowestOpticalCloudCover === undefined ? "" : `; lowest reported cloud metadata ${metrics.lowestOpticalCloudCover.toFixed(1)}%`}.`
        : "No optical source scene is catalogued for the selected window.",
      method: "Cloud-screened surface reflectance, B08/B04 index calculation, quality mask, and retained raster statistics.",
      sourceSceneIds: opticalIds,
    },
    {
      id: "change",
      label: "Change",
      ...readinessState(changeReady),
      output: "Change area not computed",
      evidence: changeReady
        ? `${metrics.totalScenes} temporally distributed catalogue scene${metrics.totalScenes === 1 ? "" : "s"} can be reviewed for a comparable pair.`
        : "At least two comparable acquisitions are required before change analysis.",
      method: "Select comparable before/after acquisitions, co-register, normalise sensor inputs, calculate change, then validate the output geometry.",
      sourceSceneIds: anyIds,
    },
    {
      id: "flood",
      label: "Flood extent",
      ...readinessState(floodReady),
      output: "Flood extent not computed",
      evidence: floodReady
        ? `${metrics.sarScenes} SAR scene${metrics.sarScenes === 1 ? "" : "s"} catalogued; SAR can support an all-weather water workflow after calibration and quality checks.`
        : "No SAR source scene is catalogued for the selected window.",
      method: "Calibrate SAR backscatter, apply documented water classification and terrain/layover checks, cross-check optical evidence where usable, then validate the polygon.",
      sourceSceneIds: sarIds,
    },
    {
      id: "objects",
      label: "Objects",
      state: "needs-authorised-imagery",
      stateLabel: "Needs authorised high-resolution imagery",
      output: "Object count not computed",
      evidence: `The current catalogue contains ${metrics.totalScenes} Sentinel scene${metrics.totalScenes === 1 ? "" : "s"}; a specific object-count claim also needs task-suitable resolution and a validated segmentation model.`,
      method: "Use authorised task-suitable imagery, a versioned segmentation model, confidence thresholds, manual review sampling, and retained output polygons.",
      sourceSceneIds: anyIds,
    },
  ];
}

function buildEvidence(aoi: AreaOfInterest, measurements: BBoxGeodesicMeasurement, metrics: CatalogueMetrics, scenes: readonly CatalogScene[]): InvestigationEvidence[] {
  const evidence: InvestigationEvidence[] = [
    {
      kind: "geometry",
      label: "AOI bounding-box area",
      value: `${measurements.formattedArea} · ${measurements.method}`,
    },
    {
      kind: "geometry",
      label: "AOI bounding-box perimeter",
      value: `${measurements.formattedPerimeter} · ${aoi.name}`,
    },
  ];

  if (metrics.totalScenes === 0) {
    evidence.push({ kind: "withheld", label: "Source acquisition", value: "No catalogue scene is available for the selected range." });
    return evidence;
  }

  evidence.push({
    kind: "catalogue",
    label: "Catalogue coverage",
    value: `${metrics.totalScenes} scene${metrics.totalScenes === 1 ? "" : "s"}: ${metrics.opticalScenes} optical, ${metrics.sarScenes} SAR. Latest: ${dateLabel(metrics.latestAcquisition)}.`,
  });

  if (metrics.latestOpticalCloudCover !== undefined) {
    evidence.push({
      kind: "quality",
      label: "Latest optical cloud metadata",
      value: `${metrics.latestOpticalCloudCover.toFixed(1)}% cloud cover; this is scene metadata, not a pixel-level cloud mask.`,
    });
  }

  sortScenesByNewest(scenes).slice(0, 3).forEach((scene) => {
    evidence.push({
      kind: "catalogue",
      label: scene.collection === "sentinel-1-grd" ? "Sentinel-1 SAR acquisition" : "Sentinel-2 optical acquisition",
      value: `${scene.id} · ${dateLabel(scene.datetime)}`,
      sourceSceneId: scene.id,
    });
  });

  return evidence;
}

/**
 * Turns a user's question and verified STAC metadata into a safe investigation
 * brief. It can be rendered directly as the product's natural-language response.
 */
export function buildInvestigationBrief(
  request: InvestigationRequest,
  scenes: readonly CatalogScene[],
  options: InvestigationEngineOptions = {},
): InvestigationBrief {
  const generatedAt = options.generatedAt ?? new Date();
  const question = request.question.trim().replace(/\s+/g, " ") || "Review the selected area.";
  const intents = detectInvestigationIntents(question);
  const measurements = calculateBBoxGeodesics(request.aoi.bbox);
  const catalogue = deriveCatalogueMetrics(scenes, generatedAt);
  const plan = buildPlan({ ...request, question }, intents, scenes, measurements);
  const analysisReadiness = buildAnalysisReadiness(measurements, catalogue, scenes);
  const intentSummary = intents.map(intentName).join(" and ");
  const catalogueSummary = catalogue.totalScenes > 0
    ? `${catalogue.totalScenes} source acquisition${catalogue.totalScenes === 1 ? " is" : "s are"} catalogued, including ${catalogue.opticalScenes} optical and ${catalogue.sarScenes} SAR scene${catalogue.sarScenes === 1 ? "" : "s"}.`
    : "No source acquisition was returned for the selected date range.";
  const naturalLanguageSummary = `I understand this as a request for ${intentSummary} in ${request.aoi.name}. ${catalogueSummary}`;
  const predictiveResponse = plan.predictiveQuestion
    ? "Predictive result withheld. A forecast or risk score requires a calibrated, versioned model, current validated inputs, and documented validation for this AOI; catalogue metadata alone is not predictive evidence."
    : "No predictive result is issued. This investigation has not run a calibrated predictive model.";
  const caveats = [
    measurements.method,
    "Catalogue metadata establishes acquisition availability, not a pixel-derived environmental finding.",
    "Flood, vegetation, change, and object outputs remain withheld until the relevant processing workflow records its source imagery, parameters, quality checks, and evidence geometry.",
  ];

  return {
    question,
    naturalLanguageSummary,
    descriptiveResponse: descriptiveClaimFor(intents, measurements),
    predictiveResponse,
    claimStatus: catalogue.totalScenes > 0 ? "catalogue-and-geometry-only" : "no-catalogue-evidence",
    measurements,
    catalogue,
    plan,
    analysisReadiness,
    evidence: buildEvidence(request.aoi, measurements, catalogue, scenes),
    caveats,
    generatedAt: generatedAt.toISOString(),
  };
}

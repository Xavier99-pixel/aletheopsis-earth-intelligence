import type { InvestigationBrief } from "./investigationEngine";
import type { CatalogScene, InvestigationRequest } from "./types";
import type { RainfallOutlook } from "../services/weather";

/**
 * Evidence-bounded conversation primitives for ALETHEOPSIS.
 *
 * This module intentionally contains no model call. The fallback reply is made
 * entirely from the investigation context passed into it, so it cannot turn a
 * catalogue listing into an unverified flood, change, vegetation, or object
 * finding. `createEvidenceBoundModelRequest` is the hand-off contract for a
 * future server-side LLM / compact local model, where the same boundaries must
 * be preserved.
 */

export type ConversationClaimStatus =
  | "verified-geometry"
  | "evidence-bounded"
  | "withheld-pending-processing"
  | "not-available";

export type ConversationIntent =
  | "summary"
  | "measurement"
  | "method"
  | "catalogue"
  | "weather"
  | "timeline"
  | "predictive"
  | "pixel-analysis"
  | "next-steps";

export type DisasterTimelineEvent = {
  /** A stable identifier from the incident provider, if one is available. */
  id?: string;
  title: string;
  date: string;
  category?: string;
  detail?: string;
  sourceName: string;
  sourceUrl?: string;
  /** True only when the provider record was geospatially matched to the AOI. */
  aoiMatched?: boolean;
};

export type DisasterTimelineContext = {
  queriedRange?: { startDate: string; endDate: string };
  events: readonly DisasterTimelineEvent[];
  providerName?: string;
  providerUrl?: string;
  note?: string;
};

export type ConversationSource = {
  id: string;
  label: string;
  detail: string;
  kind: "geometry" | "catalogue" | "quality" | "weather" | "incident" | "withheld";
  href?: string;
};

export type ConversationCalculation = {
  label: string;
  value: string;
  method: string;
  state: "computed" | "reported" | "not-run";
};

export type ConversationTurn = {
  id: string;
  question: string;
  intent: ConversationIntent;
  answer: string;
  claimStatus: ConversationClaimStatus;
  claimLabel: string;
  explanation: string;
  calculations: ConversationCalculation[];
  sources: ConversationSource[];
  suggestedFollowUps: string[];
  generatedAt: string;
  /** Always true for this client-side implementation. */
  deterministicFallback: true;
};

export type ConversationContext = {
  request: InvestigationRequest;
  brief: InvestigationBrief | null;
  /** Optional raw scene records add direct STAC links to the source list. */
  scenes?: readonly CatalogScene[];
  rainfallOutlook?: RainfallOutlook | null;
  timeline?: DisasterTimelineContext | null;
};

export type EvidenceBoundModelRequest = {
  systemInstruction: string;
  question: string;
  evidence: {
    aoiName: string;
    dateRange: { startDate: string; endDate: string };
    claimStatus: ConversationClaimStatus;
    calculations: ConversationCalculation[];
    sources: ConversationSource[];
    caveats: string[];
  };
  responseRequirements: string[];
};

const SPACE = /\s+/g;
const MEASUREMENT_TERMS = /\b(area|size|perimeter|distance|how (?:large|big|much)|measure(?:ment)?)\b/i;
const METHOD_TERMS = /\b(how (?:did|do)|method|calculation|calculate|formula|workflow|process|why|confidence|evidence)\b/i;
const CATALOGUE_TERMS = /\b(scene|image(?:ry)?|acquisition|catalog(?:ue|ue)|sentinel|sar|optical|source|date|coverage|cloud)\b/i;
const WEATHER_TERMS = /\b(weather|rain|rainfall|precipitation|monsoon|climate|temperature|humidity|wind|storm|heat|cold|forecast)\b/i;
const TIMELINE_TERMS = /\b(incident(?:s)?|disaster(?:s)?|calamit(?:y|ies)|event(?:s)?|earthquake|cyclone|landslide|fire|drought|occur(?:red|rence)|history)\b/i;
const PREDICTIVE_TERMS = /\b(predict|forecast|risk|likely|will|future|expect(?:ed|ation)?)\b/i;
const PIXEL_ANALYSIS_TERMS = /\b(flood(?:ed|ing)?|inundat(?:e|ed|ion)|water extent|ndvi|vegetation|crop|change|encroach|object|building|road|count|segment)\b/i;
const NEXT_STEP_TERMS = /\b(next|what should|what can|proceed|run|analyse|analyze|start)\b/i;

function cleanQuestion(question: string) {
  return question.trim().replace(SPACE, " ");
}

function formatDate(value: string | undefined) {
  if (!value) return "not available";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function sceneLabel(scene: CatalogScene) {
  const family = scene.collection === "sentinel-1-grd" ? "Sentinel-1 SAR" : "Sentinel-2 optical";
  return `${family} · ${formatDate(scene.datetime)}`;
}

function chooseIntent(question: string): ConversationIntent {
  // Priority matters: "what disasters happened and what is the risk" should
  // first show the reported incident evidence, rather than invent a forecast.
  if (TIMELINE_TERMS.test(question)) return "timeline";
  if (MEASUREMENT_TERMS.test(question)) return "measurement";
  if (METHOD_TERMS.test(question)) return "method";
  if (WEATHER_TERMS.test(question)) return "weather";
  if (PREDICTIVE_TERMS.test(question)) return "predictive";
  if (CATALOGUE_TERMS.test(question)) return "catalogue";
  if (PIXEL_ANALYSIS_TERMS.test(question)) return "pixel-analysis";
  if (NEXT_STEP_TERMS.test(question)) return "next-steps";
  return "summary";
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function take<T>(items: readonly T[], maximum: number): T[] {
  return items.slice(0, maximum);
}

function claimDetails(status: ConversationClaimStatus) {
  if (status === "verified-geometry") {
    return { label: "Computed geometry", explanation: "The answer is a deterministic calculation from the selected bounding box." };
  }
  if (status === "evidence-bounded") {
    return { label: "Evidence-bounded", explanation: "The answer is limited to the listed metadata, weather context, or cited incident records." };
  }
  if (status === "withheld-pending-processing") {
    return { label: "Claim withheld", explanation: "A source-pixel workflow or calibrated model is required before this environmental claim can be issued." };
  }
  return { label: "Evidence unavailable", explanation: "There is no matching evidence in the current investigation context." };
}

function geometryCalculations(context: ConversationContext): ConversationCalculation[] {
  const measurement = context.brief?.measurements;
  if (!measurement) return [];
  return [
    {
      label: "AOI bounding-box area",
      value: measurement.formattedArea,
      method: measurement.method,
      state: "computed",
    },
    {
      label: "AOI bounding-box perimeter",
      value: measurement.formattedPerimeter,
      method: "Great-circle distances along the four bounding-box edges on a spherical-Earth approximation.",
      state: "computed",
    },
  ];
}

function catalogueSources(context: ConversationContext): ConversationSource[] {
  const brief = context.brief;
  if (!brief) return [];
  const evidence = brief.evidence.map((item, index): ConversationSource => ({
    id: `brief-${index}`,
    label: item.label,
    detail: item.value,
    kind: item.kind,
  }));
  return evidence;
}

function sceneSources(scenes: readonly CatalogScene[]): ConversationSource[] {
  return take(scenes, 3).map((scene) => ({
    id: `scene-${scene.id}`,
    label: sceneLabel(scene),
    detail: scene.id,
    kind: "catalogue" as const,
    href: scene.stacUrl,
  }));
}

function weatherSources(rainfallOutlook: RainfallOutlook | null | undefined): ConversationSource[] {
  if (!rainfallOutlook) return [];
  return [{
    id: "rainfall-outlook",
    label: "Atmospheric forecast and climate record",
    detail: `${rainfallOutlook.startDate ?? "start date unavailable"} to ${rainfallOutlook.endDate ?? "end date unavailable"}; refreshed ${formatDate(rainfallOutlook.fetchedAt)}.`,
    kind: "weather",
  }];
}

function timelineSources(timeline: DisasterTimelineContext | null | undefined): ConversationSource[] {
  if (!timeline) return [];
  const events = take(timeline.events, 5).map((event, index) => ({
    id: event.id ?? `incident-${index}`,
    label: event.title,
    detail: `${formatDate(event.date)}${event.category ? ` · ${event.category}` : ""}${event.aoiMatched ? " · AOI matched" : ""} · ${event.sourceName}${event.detail ? ` · ${event.detail}` : ""}`,
    kind: "incident" as const,
    href: event.sourceUrl,
  }));
  if (events.length > 0) return events;
  if (!timeline.providerName) return [];
  return [{
    id: "incident-provider",
    label: timeline.providerName,
    detail: timeline.note ?? "No incident record was returned for the selected date range.",
    kind: "incident",
    href: timeline.providerUrl,
  }];
}

function fallbackSources(context: ConversationContext): ConversationSource[] {
  const sources = [
    ...catalogueSources(context),
    ...sceneSources(context.scenes ?? []),
    ...weatherSources(context.rainfallOutlook),
    ...timelineSources(context.timeline),
  ];
  if (sources.length > 0) return sources;
  return [{
    id: "no-investigation-evidence",
    label: "Current investigation context",
    detail: "Run an investigation to establish geometry, source availability, and traceable evidence.",
    kind: "withheld",
  }];
}

function noInvestigationTurn(question: string, generatedAt: string): ConversationTurn {
  const status: ConversationClaimStatus = "not-available";
  const claim = claimDetails(status);
  return {
    id: `turn-${generatedAt}`,
    question,
    intent: "summary",
    answer: "Run an investigation first. I can then discuss the selected area, date range, deterministic measurements, available acquisitions, and any supplied weather or incident context.",
    claimStatus: status,
    claimLabel: claim.label,
    explanation: claim.explanation,
    calculations: [],
    sources: [{
      id: "missing-investigation",
      label: "Investigation required",
      detail: "No AOI evidence brief is available in this conversation yet.",
      kind: "withheld",
    }],
    suggestedFollowUps: ["Run the selected investigation", "How is the AOI area calculated?", "What source imagery is needed for flood analysis?"],
    generatedAt,
    deterministicFallback: true,
  };
}

function withoutPixelsAnswer(context: ConversationContext) {
  const intents = context.brief?.plan.intents ?? [];
  const intended = intents.length > 0 ? intents.join(", ") : "the requested environmental analysis";
  return `I cannot confirm ${intended} from the current catalogue and geometry evidence alone. The next valid route is to process suitable source pixels, record the sensor-specific parameters and quality checks, then review the resulting raster or polygon before issuing a claim.`;
}

function suggestionSet(intent: ConversationIntent, context: ConversationContext) {
  const hasRainfall = Boolean(context.rainfallOutlook);
  const hasTimeline = Boolean(context.timeline && context.timeline.events.length > 0);
  const base = [
    "How was the AOI area calculated?",
    "Which acquisitions are available in this date range?",
    "What evidence is still missing for a verified claim?",
  ];
  const additions: Partial<Record<ConversationIntent, string[]>> = {
    measurement: ["Explain the bounding-box measurement method", "What would change with a drawn polygon AOI?"],
    method: ["Which source-pixel workflow is needed next?", "Show the evidence and calculation trail"],
    catalogue: ["Which scene has the lowest cloud metadata?", "Why is SAR useful for this question?"],
    weather: ["Is this a flood prediction?", "What non-weather inputs are needed for flood risk?"],
    timeline: ["Which listed incidents were AOI matched?", "What source data supports each incident?"],
    predictive: ["What would a calibrated prediction require?", "Show the available rainfall context"],
    "pixel-analysis": ["What source-pixel workflow is needed next?", "What will be kept as evidence after processing?"],
    "next-steps": ["Which sensor should I use first?", "How do I verify the final claim?"],
    summary: ["Summarise the evidence route", "Show calculations used in this investigation"],
  };
  const optional = [hasRainfall ? "Show the rainfall screening context" : "", hasTimeline ? "Show reported incident records in this range" : ""].filter(Boolean);
  return take(unique([...(additions[intent] ?? []), ...optional, ...base]), 4);
}

function makeTurn(
  question: string,
  intent: ConversationIntent,
  status: ConversationClaimStatus,
  answer: string,
  context: ConversationContext,
  calculations: ConversationCalculation[],
  sources: ConversationSource[],
  generatedAt: string,
): ConversationTurn {
  const claim = claimDetails(status);
  return {
    id: `turn-${generatedAt}`,
    question,
    intent,
    answer,
    claimStatus: status,
    claimLabel: claim.label,
    explanation: claim.explanation,
    calculations,
    sources,
    suggestedFollowUps: suggestionSet(intent, context),
    generatedAt,
    deterministicFallback: true,
  };
}

function replyForMeasurement(question: string, context: ConversationContext, generatedAt: string) {
  const measurement = context.brief?.measurements;
  if (!measurement) return noInvestigationTurn(question, generatedAt);
  const answer = `For ${context.request.aoi.name}, the current selected bounding box is ${measurement.formattedArea} with an estimated perimeter of ${measurement.formattedPerimeter}. This is a repeatable spherical-Earth bounding-box estimate, not a survey-grade polygon measurement.`;
  return makeTurn(question, "measurement", "verified-geometry", answer, context, geometryCalculations(context), catalogueSources(context), generatedAt);
}

function replyForMethod(question: string, context: ConversationContext, generatedAt: string) {
  const brief = context.brief;
  if (!brief) return noInvestigationTurn(question, generatedAt);
  const nextStep = brief.plan.steps.find((step) => step.id === "source-pixel-analysis");
  const answer = `This workspace first calculates the AOI geometry and checks available acquisition metadata. ${nextStep?.detail ?? "A documented source-pixel workflow is required for environmental analysis."} The final claim remains bounded by the evidence retained with the result.`;
  const calculations = geometryCalculations(context);
  if (nextStep) {
    calculations.push({
      label: "Source-pixel analysis",
      value: nextStep.state === "needs-imagery" ? "Not run" : nextStep.state,
      method: nextStep.detail,
      state: "not-run",
    });
  }
  return makeTurn(question, "method", "evidence-bounded", answer, context, calculations, fallbackSources(context), generatedAt);
}

function replyForCatalogue(question: string, context: ConversationContext, generatedAt: string) {
  const catalogue = context.brief?.catalogue;
  if (!catalogue) return noInvestigationTurn(question, generatedAt);
  const range = `${formatDate(context.request.startDate)} to ${formatDate(context.request.endDate)}`;
  const answer = catalogue.totalScenes > 0
    ? `For ${context.request.aoi.name} from ${range}, the catalogue returned ${catalogue.totalScenes} acquisition${catalogue.totalScenes === 1 ? "" : "s"}: ${catalogue.opticalScenes} optical and ${catalogue.sarScenes} SAR. The latest timestamp is ${formatDate(catalogue.latestAcquisition)}; catalogue availability does not itself prove an environmental condition.`
    : `No catalogue acquisition is currently available for ${context.request.aoi.name} in the selected range (${range}). Widen the time range or adjust the AOI before a source-pixel workflow can begin.`;
  const status: ConversationClaimStatus = catalogue.totalScenes > 0 ? "evidence-bounded" : "not-available";
  return makeTurn(question, "catalogue", status, answer, context, [], fallbackSources(context), generatedAt);
}

function replyForWeather(question: string, context: ConversationContext, generatedAt: string) {
  const outlook = context.rainfallOutlook;
  if (!outlook) {
    const answer = "The live atmospheric service did not return a usable forecast for this location yet. Re-run the investigation shortly; I will not substitute catalogue metadata for a weather answer.";
    return makeTurn(question, "weather", "not-available", answer, context, [], fallbackSources(context), generatedAt);
  }
  const current = outlook.current;
  const currentText = current?.temperatureCelsius === undefined
    ? "Current conditions were not returned."
    : `Current conditions: ${current.temperatureCelsius.toFixed(1)}°C, ${current.condition.toLowerCase()}${current.humidityPercent === undefined ? "" : `, ${Math.round(current.humidityPercent)}% humidity`}${current.windKilometresPerHour === undefined ? "" : `, wind ${current.windKilometresPerHour.toFixed(1)} km/h`}.`;
  const recent = outlook.recentRainfall;
  const recentText = recent
    ? ` The most recent ${recent.sampledDays}-day record totals ${recent.totalMillimetres.toFixed(1)} mm across ${recent.rainyDays} rainy day${recent.rainyDays === 1 ? "" : "s"}.`
    : "";
  const climate = outlook.climatePattern;
  const climateText = climate
    ? ` ${climate.month} climate baseline: about ${climate.estimatedMonthlyPrecipitationMillimetres.toFixed(1)} mm for the month and ${climate.meanTemperatureCelsius.toFixed(1)}°C mean temperature.`
    : "";
  const answer = `${currentText} ${outlook.label}: ${outlook.totalMillimetres.toFixed(1)} mm is forecast from ${formatDate(outlook.startDate)} to ${formatDate(outlook.endDate)}, with a ${outlook.peakDailyMillimetres.toFixed(1)} mm/day peak and ${outlook.peakProbability}% maximum precipitation probability.${recentText}${climateText} ${outlook.caveat}`;
  const calculations: ConversationCalculation[] = [{
    label: "Seven-day forecast rainfall total",
    value: `${outlook.totalMillimetres.toFixed(1)} mm`,
    method: "Sum of returned daily precipitation values for the forecast window.",
    state: "reported",
  }];
  if (recent) {
    calculations.push({
      label: "Recent rainfall pattern",
      value: `${recent.totalMillimetres.toFixed(1)} mm / ${recent.sampledDays} days`,
      method: "Sum of returned daily precipitation values for the recent record.",
      state: "reported",
    });
  }
  if (climate) {
    calculations.push({
      label: `${climate.month} climate baseline`,
      value: `${climate.estimatedMonthlyPrecipitationMillimetres.toFixed(1)} mm/month`,
      method: `${climate.baseline}; daily climatological precipitation multiplied by days in the current month.`,
      state: "reported",
    });
  }
  return makeTurn(question, "weather", "evidence-bounded", answer, context, calculations, [...weatherSources(outlook), ...catalogueSources(context)], generatedAt);
}

function replyForTimeline(question: string, context: ConversationContext, generatedAt: string) {
  const timeline = context.timeline;
  if (!timeline) {
    const answer = `No incident timeline has been loaded for ${context.request.aoi.name} and the selected dates. I will not infer a disaster from satellite catalogue metadata or weather screening alone.`;
    return makeTurn(question, "timeline", "not-available", answer, context, [], fallbackSources(context), generatedAt);
  }
  const range = timeline.queriedRange ?? { startDate: context.request.startDate, endDate: context.request.endDate };
  const matchedEvents = timeline.events.filter((event) => event.aoiMatched !== false);
  const displayEvents = matchedEvents.length > 0 ? matchedEvents : timeline.events;
  const answer = displayEvents.length > 0
    ? `${displayEvents.length} reported incident record${displayEvents.length === 1 ? "" : "s"} ${matchedEvents.length > 0 ? "matched or were not excluded from" : "were returned for"} ${context.request.aoi.name} between ${formatDate(range.startDate)} and ${formatDate(range.endDate)}. These are cited provider records, not a satellite-derived confirmation of impacts.`
    : `No incident record was returned for ${context.request.aoi.name} between ${formatDate(range.startDate)} and ${formatDate(range.endDate)}. An empty provider result is not proof that no event occurred.`;
  return makeTurn(question, "timeline", "evidence-bounded", answer, context, [], [...timelineSources(timeline), ...catalogueSources(context)], generatedAt);
}

function replyForPredictive(question: string, context: ConversationContext, generatedAt: string) {
  const brief = context.brief;
  if (!brief) return noInvestigationTurn(question, generatedAt);
  const answer = `${brief.predictiveResponse} ${context.rainfallOutlook ? "The attached rainfall outlook can be used as contextual input, but it does not replace terrain, drainage, exposure, observed conditions, or a validated risk model." : "No forecast context is attached to the current result."}`;
  return makeTurn(question, "predictive", "withheld-pending-processing", answer, context, [], fallbackSources(context), generatedAt);
}

function replyForPixelAnalysis(question: string, context: ConversationContext, generatedAt: string) {
  const brief = context.brief;
  if (!brief) return noInvestigationTurn(question, generatedAt);
  return makeTurn(
    question,
    "pixel-analysis",
    "withheld-pending-processing",
    withoutPixelsAnswer(context),
    context,
    geometryCalculations(context),
    fallbackSources(context),
    generatedAt,
  );
}

function replyForNextSteps(question: string, context: ConversationContext, generatedAt: string) {
  const brief = context.brief;
  if (!brief) return noInvestigationTurn(question, generatedAt);
  const pending = brief.plan.steps.filter((step) => step.state !== "complete");
  const answer = pending.length > 0
    ? `Next, ${pending.map((step) => step.label.toLowerCase()).join(", then ")}. ${pending[0]?.detail ?? "Preserve the source imagery, parameters, and validation record with the result."}`
    : "The available geometry step is complete. For an environmental finding, select a suitable acquisition and run the documented source-pixel workflow before issuing a claim.";
  return makeTurn(question, "next-steps", "evidence-bounded", answer, context, geometryCalculations(context), fallbackSources(context), generatedAt);
}

function replyForSummary(question: string, context: ConversationContext, generatedAt: string) {
  const brief = context.brief;
  if (!brief) return noInvestigationTurn(question, generatedAt);
  const answer = `${brief.naturalLanguageSummary} ${brief.descriptiveResponse} ${brief.predictiveResponse}`;
  const status: ConversationClaimStatus = brief.claimStatus === "catalogue-and-geometry-only"
    ? "evidence-bounded"
    : "not-available";
  return makeTurn(question, "summary", status, answer, context, geometryCalculations(context), fallbackSources(context), generatedAt);
}

/**
 * Produce a transparent, deterministic reply from the evidence already held by
 * the browser. It is safe to render immediately, and deliberately makes no
 * claim that a hosted or on-device LLM generated the response.
 */
export function buildConversationTurn(
  context: ConversationContext,
  followUpQuestion: string,
  generatedAt = new Date().toISOString(),
): ConversationTurn {
  const question = cleanQuestion(followUpQuestion);
  if (!question) return noInvestigationTurn("Ask a follow-up about this investigation.", generatedAt);
  if (!context.brief) return noInvestigationTurn(question, generatedAt);

  const intent = chooseIntent(question);
  if (intent === "measurement") return replyForMeasurement(question, context, generatedAt);
  if (intent === "method") return replyForMethod(question, context, generatedAt);
  if (intent === "catalogue") return replyForCatalogue(question, context, generatedAt);
  if (intent === "weather") return replyForWeather(question, context, generatedAt);
  if (intent === "timeline") return replyForTimeline(question, context, generatedAt);
  if (intent === "predictive") return replyForPredictive(question, context, generatedAt);
  if (intent === "pixel-analysis") return replyForPixelAnalysis(question, context, generatedAt);
  if (intent === "next-steps") return replyForNextSteps(question, context, generatedAt);
  return replyForSummary(question, context, generatedAt);
}

/**
 * Returns a strict prompt contract for a future server-side LLM or compact
 * model. The caller must still validate any model output against the evidence
 * pack before presenting it as an ALETHEOPSIS answer.
 */
export function createEvidenceBoundModelRequest(
  context: ConversationContext,
  followUpQuestion: string,
): EvidenceBoundModelRequest {
  const fallback = buildConversationTurn(context, followUpQuestion);
  const caveats = context.brief?.caveats ?? ["No investigation evidence is available yet."];
  return {
    systemInstruction: "You are an evidence-bounded Earth observation assistant. Use only the supplied evidence. Never invent a flood, change, vegetation, object, incident, forecast, or impact finding. State when a source-pixel workflow or calibrated model is required.",
    question: fallback.question,
    evidence: {
      aoiName: context.request.aoi.name,
      dateRange: { startDate: context.request.startDate, endDate: context.request.endDate },
      claimStatus: fallback.claimStatus,
      calculations: fallback.calculations,
      sources: fallback.sources,
      caveats,
    },
    responseRequirements: [
      "Lead with a direct answer grounded only in supplied evidence.",
      "Name calculations and sources used when applicable.",
      "Preserve all withholding statements and uncertainty boundaries.",
      "Do not describe the answer as a prediction unless a calibrated model result is supplied.",
    ],
  };
}

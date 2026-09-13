import type { InvestigationBrief } from "./investigationEngine";
import type { CatalogAssessment, CatalogScene, InvestigationRequest } from "./types";
import type { RainfallOutlook } from "../services/weather";

/**
 * A portable, user-downloadable record of an Earth-intelligence investigation.
 *
 * The builder is deliberately client-side and evidence-first: it records the
 * current investigation state, but never promotes catalogue metadata or an
 * unvalidated weather screen into a pixel-derived disaster finding.
 */

export type ResearchSource = {
  label: string;
  url?: string;
  detail?: string;
};

export type DisasterTimelineEvent = {
  /** A stable source identifier when the incident provider exposes one. */
  id?: string;
  /** ISO timestamp, date, or source-supplied time label. */
  date: string;
  title: string;
  summary?: string;
  category?: string;
  severity?: "information" | "watch" | "warning" | "emergency";
  source?: ResearchSource;
};

/**
 * Optional context supplied by an incident or disaster feed. Events are
 * presented as source context, not automatically confirmed inside the AOI.
 */
export type DisasterTimelineContext = {
  status?: "available" | "limited" | "unavailable";
  summary?: string;
  source?: ResearchSource;
  events?: readonly DisasterTimelineEvent[];
  caveat?: string;
};

export type ResearchReportInput = {
  request: InvestigationRequest;
  assessment?: CatalogAssessment | null;
  brief?: InvestigationBrief | null;
  rainfallOutlook?: RainfallOutlook | null;
  disasterTimeline?: DisasterTimelineContext | null;
  /** Human-curated links such as official response bulletins or research. */
  additionalSources?: readonly ResearchSource[];
  /** Pass a fixed timestamp in tests or when reproducing a report. */
  generatedAt?: string | Date;
  reportTitle?: string;
};

export type ResearchReportSource = ResearchSource & {
  category: "catalogue" | "acquisition" | "weather" | "incident" | "additional";
};

export type ResearchReportDocument = {
  schemaVersion: "1.0";
  title: string;
  generatedAt: string;
  reportId: string;
  investigation: {
    question: string;
    areaOfInterest: {
      name: string;
      boundingBoxWgs84: InvestigationRequest["aoi"]["bbox"];
      selectionMethod: InvestigationRequest["aoi"]["source"];
    };
    selectedDates: {
      start: string;
      end: string;
    };
    selectedSensors: string[];
    selectedTools: string[];
  };
  output: {
    claimStatus: InvestigationBrief["claimStatus"] | "not-run";
    naturalLanguageSummary: string;
    descriptiveResponse: string;
    predictiveResponse: string;
  };
  deterministicCalculations: {
    name: string;
    value: string;
    method: string;
    detail?: string;
  }[];
  catalogue: {
    status: string;
    summary: string;
    source?: ResearchSource;
    queriedAt?: string;
    metrics: { label: string; value: string; detail: string }[];
    acquisitions: {
      id: string;
      collection: CatalogScene["collection"];
      datetime: string;
      platform?: string;
      cloudCover?: number;
      orbitState?: string;
      polarizations: string[];
      resolution?: number;
      stacUrl?: string;
    }[];
  };
  predictiveScreening?: {
    label: string;
    status: string;
    detail: string;
    source: ResearchSource;
    validFrom?: string;
    validTo?: string;
    totalMillimetres?: number;
    peakDailyMillimetres?: number;
    peakProbability?: number;
    currentConditions?: {
      observedAt?: string;
      temperatureCelsius?: number;
      humidityPercent?: number;
      precipitationMillimetres?: number;
      windKilometresPerHour?: number;
      condition: string;
    };
    dailyForecast?: Array<{
      date: string;
      precipitationMillimetres: number;
      precipitationProbability: number;
      temperatureMinimumCelsius?: number;
      temperatureMaximumCelsius?: number;
      condition: string;
    }>;
    recentRainfall?: {
      startDate: string;
      endDate: string;
      sampledDays: number;
      totalMillimetres: number;
      peakDailyMillimetres: number;
      rainyDays: number;
    };
    climatePattern?: {
      month: string;
      baseline: string;
      meanDailyPrecipitationMillimetres: number;
      estimatedMonthlyPrecipitationMillimetres: number;
      meanTemperatureCelsius: number;
    };
    caveat?: string;
  };
  disasterTimeline: {
    status: "available" | "limited" | "unavailable";
    summary: string;
    events: DisasterTimelineEvent[];
    source?: ResearchSource;
    caveat: string;
  };
  methodology: {
    calculations: string[];
    evidenceRoute: string[];
    caveats: string[];
  };
  sources: ResearchReportSource[];
};

export type ResearchReportFormat = "html" | "markdown" | "json";

export type ResearchReportDownload = {
  report: ResearchReportDocument;
  filename: string;
  format: ResearchReportFormat;
  mimeType: string;
};

const FORMAT_DETAILS: Record<ResearchReportFormat, { extension: string; mimeType: string }> = {
  html: { extension: "html", mimeType: "text/html;charset=utf-8" },
  markdown: { extension: "md", mimeType: "text/markdown;charset=utf-8" },
  json: { extension: "json", mimeType: "application/json;charset=utf-8" },
};

function asIso(value: string | Date | undefined) {
  if (!value) return new Date().toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function normaliseQuestion(question: string) {
  return question.trim().replace(/\s+/g, " ") || "Review the selected area.";
}

function uniqueSources(sources: ResearchReportSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.category}|${source.label}|${source.url ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableReportId(input: ResearchReportInput, generatedAt: string) {
  const material = [input.request.question, input.request.aoi.name, input.request.startDate, input.request.endDate, generatedAt].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ALET-${(hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function present(value: string | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function disasterContext(context: DisasterTimelineContext | null | undefined): ResearchReportDocument["disasterTimeline"] {
  const events = context?.events ? [...context.events] : [];
  const status = context?.status ?? (events.length > 0 ? "available" : "unavailable");
  const defaultSummary = events.length > 0
    ? `${events.length} source-reported event${events.length === 1 ? "" : "s"} was supplied for the selected time window.`
    : "No incident-feed context was supplied for this investigation.";

  return {
    status,
    summary: present(context?.summary, defaultSummary),
    events,
    source: context?.source,
    caveat: present(
      context?.caveat,
      "Timeline items are source context. They are not confirmation that an incident affected the selected AOI unless independently verified with location, time, and source imagery.",
    ),
  };
}

function catalogueRecord(assessment: CatalogAssessment | null | undefined): ResearchReportDocument["catalogue"] {
  if (!assessment) {
    return {
      status: "Investigation not run",
      summary: "No catalogue query result is attached to this report.",
      metrics: [],
      acquisitions: [],
    };
  }

  return {
    status: assessment.stateLabel,
    summary: assessment.summary,
    source: { label: assessment.sourceName, url: assessment.sourceUrl },
    queriedAt: assessment.queriedAt,
    metrics: assessment.metrics.map((metric) => ({ ...metric })),
    acquisitions: assessment.scenes.map((scene) => ({
      id: scene.id,
      collection: scene.collection,
      datetime: scene.datetime,
      platform: scene.platform,
      cloudCover: scene.cloudCover,
      orbitState: scene.orbitState,
      polarizations: [...scene.polarizations],
      resolution: scene.resolution,
      stacUrl: scene.stacUrl,
    })),
  };
}

function predictiveScreening(outlook: RainfallOutlook | null | undefined): ResearchReportDocument["predictiveScreening"] {
  if (!outlook) return undefined;
  return {
    label: "Atmospheric outlook · " + outlook.label,
    status: outlook.watchLevel,
    detail: `${outlook.detail} ${outlook.caveat}`,
    source: {
      label: "Atmospheric forecast and climate record",
      detail: outlook.provenance.map((record) => `${record.product}: ${record.role}`).join(" | "),
    },
    validFrom: outlook.startDate,
    validTo: outlook.endDate,
    totalMillimetres: outlook.totalMillimetres,
    peakDailyMillimetres: outlook.peakDailyMillimetres,
    peakProbability: outlook.peakProbability,
    currentConditions: outlook.current ? {
      observedAt: outlook.current.observedAt,
      temperatureCelsius: outlook.current.temperatureCelsius,
      humidityPercent: outlook.current.humidityPercent,
      precipitationMillimetres: outlook.current.precipitationMillimetres,
      windKilometresPerHour: outlook.current.windKilometresPerHour,
      condition: outlook.current.condition,
    } : undefined,
    dailyForecast: outlook.dailyForecast.map((day) => ({
      date: day.date,
      precipitationMillimetres: day.precipitationMillimetres,
      precipitationProbability: day.precipitationProbability,
      temperatureMinimumCelsius: day.temperatureMinimumCelsius,
      temperatureMaximumCelsius: day.temperatureMaximumCelsius,
      condition: day.condition,
    })),
    recentRainfall: outlook.recentRainfall ? { ...outlook.recentRainfall } : undefined,
    climatePattern: outlook.climatePattern ? { ...outlook.climatePattern } : undefined,
    caveat: outlook.caveat,
  };
}

function calculationRecords(brief: InvestigationBrief | null | undefined): ResearchReportDocument["deterministicCalculations"] {
  if (!brief) {
    return [{
      name: "Deterministic calculation",
      value: "Not run",
      method: "Run an investigation to calculate AOI geometry and compile source evidence.",
    }];
  }

  const measurement = brief.measurements;
  return [
    {
      name: "AOI bounding-box area",
      value: measurement.formattedArea,
      method: measurement.method,
      detail: `Latitude span ${measurement.latitudeSpanDegrees}°, longitude span ${measurement.longitudeSpanDegrees}°.`,
    },
    {
      name: "AOI bounding-box perimeter",
      value: measurement.formattedPerimeter,
      method: "Great-circle edge lengths calculated on a spherical Earth using the mean Earth radius.",
      detail: `North ${measurement.northEdgeKilometres} km; south ${measurement.southEdgeKilometres} km; east ${measurement.eastEdgeKilometres} km; west ${measurement.westEdgeKilometres} km.`,
    },
  ];
}

function sourceRecords(
  assessment: CatalogAssessment | null | undefined,
  outlook: RainfallOutlook | null | undefined,
  timeline: ResearchReportDocument["disasterTimeline"],
  additionalSources: readonly ResearchSource[] | undefined,
) {
  const sources: ResearchReportSource[] = [];
  if (assessment?.sourceName) {
    sources.push({ category: "catalogue", label: assessment.sourceName, url: assessment.sourceUrl, detail: "Catalogue query used in this report." });
  }
  assessment?.scenes.forEach((scene) => {
    if (scene.stacUrl) {
      sources.push({
        category: "acquisition",
        label: `${scene.collection} · ${scene.id}`,
        url: scene.stacUrl,
        detail: scene.datetime,
      });
    }
  });
  if (outlook) {
    sources.push({
      category: "weather",
      label: "Atmospheric forecast and climate record",
      detail: outlook.provenance.map((record) => `${record.product}: ${record.role}`).join(" | "),
    });
  }
  if (timeline.source) {
    sources.push({ category: "incident", ...timeline.source, detail: timeline.source.detail ?? "Incident timeline context." });
  }
  timeline.events.forEach((event) => {
    if (event.source) {
      sources.push({
        category: "incident",
        ...event.source,
        detail: event.source.detail ?? `${event.date} · ${event.title}`,
      });
    }
  });
  additionalSources?.forEach((source) => sources.push({ category: "additional", ...source }));
  return uniqueSources(sources);
}

/** Build a serialisable, auditable report from the current investigation state. */
export function buildResearchReport(input: ResearchReportInput): ResearchReportDocument {
  const generatedAt = asIso(input.generatedAt);
  const brief = input.brief ?? undefined;
  const timeline = disasterContext(input.disasterTimeline);
  const catalogue = catalogueRecord(input.assessment);
  const output = brief
    ? {
      claimStatus: brief.claimStatus,
      naturalLanguageSummary: brief.naturalLanguageSummary,
      descriptiveResponse: brief.descriptiveResponse,
      predictiveResponse: brief.predictiveResponse,
    }
    : {
      claimStatus: "not-run" as const,
      naturalLanguageSummary: "No analysis was run before this report was generated.",
      descriptiveResponse: "No descriptive output is available.",
      predictiveResponse: "No predictive output is available.",
    };

  const calculation = calculationRecords(brief);
  const caveats = brief?.caveats ?? [
    "No source-pixel analysis or calibrated predictive model result is included because an investigation was not run.",
  ];
  if (input.rainfallOutlook) {
    caveats.push("Weather screening is not a flood, inundation, damage, or exposure prediction.");
  }

  return {
    schemaVersion: "1.0",
    title: present(input.reportTitle, "ALETHEOPSIS Earth Intelligence research report"),
    generatedAt,
    reportId: stableReportId(input, generatedAt),
    investigation: {
      question: normaliseQuestion(input.request.question),
      areaOfInterest: {
        name: input.request.aoi.name,
        boundingBoxWgs84: [...input.request.aoi.bbox] as InvestigationRequest["aoi"]["bbox"],
        selectionMethod: input.request.aoi.source,
      },
      selectedDates: { start: input.request.startDate, end: input.request.endDate },
      selectedSensors: [...input.request.sensors],
      selectedTools: [...input.request.tools],
    },
    output,
    deterministicCalculations: calculation,
    catalogue,
    predictiveScreening: predictiveScreening(input.rainfallOutlook),
    disasterTimeline: timeline,
    methodology: {
      calculations: calculation.map((item) => `${item.name}: ${item.method}`),
      evidenceRoute: brief?.plan.steps.map((step) => `${step.label} [${step.state}]: ${step.detail}`) ?? [
        "No evidence route was generated because the investigation did not run.",
      ],
      caveats: [...new Set([...caveats, timeline.caveat])],
    },
    sources: sourceRecords(input.assessment, input.rainfallOutlook, timeline, input.additionalSources),
  };
}

function markdownEscape(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownLink(source: ResearchSource) {
  return source.url ? `[${markdownEscape(source.label)}](${source.url})` : markdownEscape(source.label);
}

function markdownTable(rows: readonly string[][], headers: readonly string[]) {
  if (rows.length === 0) return "No records were returned.\n";
  const header = `| ${headers.map(markdownEscape).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => markdownEscape(cell)).join(" | ")} |`).join("\n");
  return `${header}\n${divider}\n${body}\n`;
}

function atmosphericMarkdown(screening: NonNullable<ResearchReportDocument["predictiveScreening"]>) {
  const lines = [
    `**${screening.label}** (${screening.status})`,
    "",
    screening.detail,
    "",
    `**Valid window:** ${screening.validFrom ?? "—"} to ${screening.validTo ?? "—"}  `,
    `**Record:** ${markdownLink(screening.source)}`,
    "",
  ];

  if (screening.currentConditions) {
    const current = screening.currentConditions;
    lines.push(
      "### Current conditions",
      "",
      `${current.condition}${current.observedAt ? ` · ${current.observedAt}` : ""}${current.temperatureCelsius === undefined ? "" : ` · ${current.temperatureCelsius.toFixed(1)} °C`}${current.humidityPercent === undefined ? "" : ` · ${Math.round(current.humidityPercent)}% humidity`}${current.windKilometresPerHour === undefined ? "" : ` · ${current.windKilometresPerHour.toFixed(1)} km/h wind`}.`,
      "",
    );
  }

  if (screening.dailyForecast && screening.dailyForecast.length > 0) {
    lines.push(
      "### Seven-day rainfall forecast",
      "",
      markdownTable(
        screening.dailyForecast.map((day) => [
          day.date,
          `${day.precipitationMillimetres.toFixed(1)} mm`,
          `${day.precipitationProbability}%`,
          day.temperatureMinimumCelsius === undefined || day.temperatureMaximumCelsius === undefined
            ? "—"
            : `${day.temperatureMinimumCelsius.toFixed(0)}–${day.temperatureMaximumCelsius.toFixed(0)} °C`,
          day.condition,
        ]),
        ["Date", "Rainfall", "Probability", "Temperature", "Condition"],
      ),
    );
  }

  if (screening.recentRainfall) {
    const record = screening.recentRainfall;
    lines.push(
      "### Recent rainfall record",
      "",
      `${record.startDate} to ${record.endDate}: ${record.totalMillimetres.toFixed(1)} mm across ${record.sampledDays} days; ${record.rainyDays} rainy days; ${record.peakDailyMillimetres.toFixed(1)} mm wettest day.`,
      "",
    );
  }

  if (screening.climatePattern) {
    const climate = screening.climatePattern;
    lines.push(
      "### Monthly climate baseline",
      "",
      `${climate.month}: ${climate.estimatedMonthlyPrecipitationMillimetres.toFixed(1)} mm estimated monthly precipitation, ${climate.meanDailyPrecipitationMillimetres.toFixed(1)} mm/day and ${climate.meanTemperatureCelsius.toFixed(1)} °C mean temperature. ${climate.baseline}`,
      "",
    );
  }

  if (screening.caveat) lines.push(`**Interpretation:** ${screening.caveat}`, "");
  return lines;
}

/** Render a human-readable Markdown report with all evidence and caveats. */
export function renderResearchReportMarkdown(report: ResearchReportDocument) {
  const aoi = report.investigation.areaOfInterest;
  const acquisitionRows = report.catalogue.acquisitions.map((scene) => [
    scene.collection,
    scene.datetime,
    scene.id,
    scene.cloudCover === undefined ? "—" : `${scene.cloudCover.toFixed(1)}%`,
    scene.stacUrl ?? "No item link",
  ]);
  const incidentRows = report.disasterTimeline.events.map((event) => [
    event.date,
    event.category ?? "Incident context",
    event.title,
    event.severity ?? "information",
    event.source?.url ?? event.source?.label ?? "No source link",
  ]);

  const lines = [
    `# ${report.title}`,
    "",
    `**Report ID:** ${report.reportId}  `,
    `**Generated:** ${report.generatedAt}`,
    "",
    "## Investigation",
    "",
    `**Question:** ${report.investigation.question}`,
    "",
    `**Area of interest:** ${aoi.name}  `,
    `**WGS84 bounding box:** ${aoi.boundingBoxWgs84.join(", ")}  `,
    `**Selection method:** ${aoi.selectionMethod}  `,
    `**Selected dates:** ${report.investigation.selectedDates.start} to ${report.investigation.selectedDates.end}  `,
    `**Sensors:** ${report.investigation.selectedSensors.join(", ") || "None selected"}  `,
    `**GIS tools:** ${report.investigation.selectedTools.join(", ") || "None selected"}`,
    "",
    "## Intelligence output",
    "",
    `**Claim status:** ${report.output.claimStatus}`,
    "",
    report.output.naturalLanguageSummary,
    "",
    "### Descriptive response",
    "",
    report.output.descriptiveResponse,
    "",
    "### Predictive response",
    "",
    report.output.predictiveResponse,
    "",
    "## Deterministic calculations",
    "",
    ...report.deterministicCalculations.flatMap((calculation) => [
      `### ${calculation.name}`,
      "",
      `**Result:** ${calculation.value}  `,
      `**Method:** ${calculation.method}${calculation.detail ? `  \n**Detail:** ${calculation.detail}` : ""}`,
      "",
    ]),
    "## Catalogue evidence",
    "",
    `**Status:** ${report.catalogue.status}  `,
    `**Summary:** ${report.catalogue.summary}${report.catalogue.source ? `  \n**Source:** ${markdownLink(report.catalogue.source)}` : ""}`,
    "",
    "### Query metrics",
    "",
    markdownTable(report.catalogue.metrics.map((metric) => [metric.label, metric.value, metric.detail]), ["Metric", "Value", "Detail"]),
    "### Acquisitions",
    "",
    markdownTable(acquisitionRows, ["Collection", "Time", "Scene ID", "Cloud", "STAC item"]),
    "## Atmospheric outlook",
    "",
  ];

  if (report.predictiveScreening) {
    lines.push(...atmosphericMarkdown(report.predictiveScreening));
  } else {
    lines.push("No live atmospheric result was attached to this investigation.", "");
  }

  lines.push(
    "## Disaster / incident timeline context",
    "",
    `**Availability:** ${report.disasterTimeline.status}  `,
    report.disasterTimeline.summary,
    report.disasterTimeline.source ? `  \n**Source:** ${markdownLink(report.disasterTimeline.source)}` : "",
    "",
    markdownTable(incidentRows, ["Date", "Category", "Event", "Severity", "Source"]),
    "## Methodology and caveats",
    "",
    "### Evidence route",
    "",
    ...report.methodology.evidenceRoute.map((step) => `- ${step}`),
    "",
    "### Caveats",
    "",
    ...report.methodology.caveats.map((caveat) => `- ${caveat}`),
    "",
    "## Research sources",
    "",
    ...(report.sources.length > 0
      ? report.sources.map((source) => `- **${source.category}:** ${markdownLink(source)}${source.detail ? ` — ${source.detail}` : ""}`)
      : ["- No linked sources were supplied."]),
    "",
    "---",
    "This report records the evidence available at generation time. It must not be used as a substitute for official emergency warnings, local ground observation, or a validated operational model.",
    "",
  );

  return lines.join("\n");
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sourceHtml(source: ResearchSource) {
  const label = htmlEscape(source.label);
  return source.url
    ? `<a href="${htmlEscape(source.url)}" target="_blank" rel="noreferrer">${label}</a>`
    : label;
}

function tableHtml(headers: readonly string[], rows: readonly string[][]) {
  if (rows.length === 0) return "<p class=\"muted\">No records were returned.</p>";
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function atmosphericHtml(screening: NonNullable<ResearchReportDocument["predictiveScreening"]>) {
  const current = screening.currentConditions;
  const currentHtml = current
    ? `<h3>Current conditions</h3><p>${htmlEscape(`${current.condition}${current.observedAt ? ` · ${current.observedAt}` : ""}${current.temperatureCelsius === undefined ? "" : ` · ${current.temperatureCelsius.toFixed(1)} °C`}${current.humidityPercent === undefined ? "" : ` · ${Math.round(current.humidityPercent)}% humidity`}${current.windKilometresPerHour === undefined ? "" : ` · ${current.windKilometresPerHour.toFixed(1)} km/h wind`}.`)}</p>`
    : "";
  const forecastHtml = screening.dailyForecast?.length
    ? `<h3>Seven-day rainfall forecast</h3>${tableHtml(
      ["Date", "Rainfall", "Probability", "Temperature", "Condition"],
      screening.dailyForecast.map((day) => [
        day.date,
        `${day.precipitationMillimetres.toFixed(1)} mm`,
        `${day.precipitationProbability}%`,
        day.temperatureMinimumCelsius === undefined || day.temperatureMaximumCelsius === undefined
          ? "—"
          : `${day.temperatureMinimumCelsius.toFixed(0)}–${day.temperatureMaximumCelsius.toFixed(0)} °C`,
        day.condition,
      ]),
    )}`
    : "";
  const recent = screening.recentRainfall;
  const recentHtml = recent
    ? `<h3>Recent rainfall record</h3><p>${htmlEscape(`${recent.startDate} to ${recent.endDate}: ${recent.totalMillimetres.toFixed(1)} mm across ${recent.sampledDays} days; ${recent.rainyDays} rainy days; ${recent.peakDailyMillimetres.toFixed(1)} mm wettest day.`)}</p>`
    : "";
  const climate = screening.climatePattern;
  const climateHtml = climate
    ? `<h3>Monthly climate baseline</h3><p>${htmlEscape(`${climate.month}: ${climate.estimatedMonthlyPrecipitationMillimetres.toFixed(1)} mm estimated monthly precipitation, ${climate.meanDailyPrecipitationMillimetres.toFixed(1)} mm/day and ${climate.meanTemperatureCelsius.toFixed(1)} °C mean temperature. ${climate.baseline}`)}</p>`
    : "";
  return `<div class="notice"><h3>${htmlEscape(screening.label)} · ${htmlEscape(screening.status)}</h3><p>${htmlEscape(screening.detail)}</p><p><b>Window:</b> ${htmlEscape(screening.validFrom ?? "—")} to ${htmlEscape(screening.validTo ?? "—")}<br><b>Record:</b> ${sourceHtml(screening.source)}</p></div>${currentHtml}${forecastHtml}${recentHtml}${climateHtml}${screening.caveat ? `<p class="muted"><b>Interpretation:</b> ${htmlEscape(screening.caveat)}</p>` : ""}`;
}

/** Render a printable standalone HTML report. */
export function renderResearchReportHtml(report: ResearchReportDocument) {
  const aoi = report.investigation.areaOfInterest;
  const calculations = report.deterministicCalculations.map((calculation) => `
    <article class="card"><h3>${htmlEscape(calculation.name)}</h3><strong>${htmlEscape(calculation.value)}</strong>
    <p><b>Method:</b> ${htmlEscape(calculation.method)}</p>${calculation.detail ? `<p>${htmlEscape(calculation.detail)}</p>` : ""}</article>`).join("");
  const acquisitionTable = tableHtml(
    ["Collection", "Time", "Scene ID", "Cloud", "STAC item"],
    report.catalogue.acquisitions.map((scene) => [scene.collection, scene.datetime, scene.id, scene.cloudCover === undefined ? "—" : `${scene.cloudCover.toFixed(1)}%`, scene.stacUrl ?? "No item link"]),
  );
  const incidentTable = tableHtml(
    ["Date", "Category", "Event", "Severity", "Source"],
    report.disasterTimeline.events.map((event) => [event.date, event.category ?? "Incident context", event.title, event.severity ?? "information", event.source?.url ?? event.source?.label ?? "No source link"]),
  );
  const metricTable = tableHtml(
    ["Metric", "Value", "Detail"],
    report.catalogue.metrics.map((metric) => [metric.label, metric.value, metric.detail]),
  );
  const outlookHtml = report.predictiveScreening
    ? atmosphericHtml(report.predictiveScreening)
    : "<p class=\"muted\">No live atmospheric result was attached to this investigation.</p>";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(report.title)}</title><style>
  :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f7f7f4}
  body{margin:0;background:#f7f7f4;line-height:1.55}.page{max-width:950px;margin:0 auto;padding:42px 28px 72px}header{border-bottom:4px solid #d4a900;padding-bottom:24px;margin-bottom:30px}.eyebrow{color:#806600;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.identity{display:flex;gap:12px;align-items:center}.mark{font-weight:900;font-size:28px;color:#bc9500}.meta{color:#666;font-size:14px}h1{font-size:32px;line-height:1.15;margin:8px 0 12px}h2{margin:34px 0 12px;font-size:21px}h3{font-size:15px;margin:0 0 8px}p{margin:8px 0}.lead{font-size:17px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{background:white;border:1px solid #deded8;border-radius:10px;padding:16px}.card strong{font-size:20px}.notice{border-left:4px solid #d4a900;background:#fffae8;padding:13px 16px}.warn{border-left-color:#9a3523;background:#fff5f2}.table-wrap{overflow-x:auto;border:1px solid #deded8;border-radius:10px;background:white}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid #ecece7;vertical-align:top}th{background:#f0efe9;font-size:11px;letter-spacing:.06em;text-transform:uppercase}tr:last-child td{border-bottom:0}a{color:#5b4700}.muted,.meta{color:#656565}ul{padding-left:21px}@media print{body{background:white}.page{max-width:none;padding:22px}.card{break-inside:avoid}.table-wrap{break-inside:avoid}}@media(max-width:620px){.page{padding:28px 17px 48px}h1{font-size:27px}.grid{grid-template-columns:1fr}}
</style></head><body><main class="page">
<header><div class="identity"><span class="mark">Α◉</span><span class="eyebrow">ALETHEOPSIS · Earth intelligence research record</span></div><h1>${htmlEscape(report.title)}</h1><div class="meta">Report ${htmlEscape(report.reportId)} · Generated ${htmlEscape(report.generatedAt)}</div></header>
<section><h2>Investigation</h2><div class="card"><p><b>Question</b></p><p class="lead">${htmlEscape(report.investigation.question)}</p><p><b>Area of interest:</b> ${htmlEscape(aoi.name)} (${htmlEscape(aoi.boundingBoxWgs84.join(", "))})</p><p><b>Selected dates:</b> ${htmlEscape(report.investigation.selectedDates.start)} to ${htmlEscape(report.investigation.selectedDates.end)}</p><p><b>Sensors:</b> ${htmlEscape(report.investigation.selectedSensors.join(", ") || "None selected")}<br><b>GIS tools:</b> ${htmlEscape(report.investigation.selectedTools.join(", ") || "None selected")}</p></div></section>
<section><h2>Intelligence output</h2><div class="notice"><b>Claim status:</b> ${htmlEscape(report.output.claimStatus)}</div><p class="lead">${htmlEscape(report.output.naturalLanguageSummary)}</p><div class="grid"><article class="card"><h3>Descriptive response</h3><p>${htmlEscape(report.output.descriptiveResponse)}</p></article><article class="card"><h3>Predictive response</h3><p>${htmlEscape(report.output.predictiveResponse)}</p></article></div></section>
<section><h2>Deterministic calculations</h2><div class="grid">${calculations}</div></section>
<section><h2>Catalogue evidence</h2><p><b>Status:</b> ${htmlEscape(report.catalogue.status)}</p><p>${htmlEscape(report.catalogue.summary)}</p>${report.catalogue.source ? `<p><b>Source:</b> ${sourceHtml(report.catalogue.source)}</p>` : ""}<h3>Query metrics</h3>${metricTable}<h3>Acquisitions</h3>${acquisitionTable}</section>
<section><h2>Atmospheric outlook</h2>${outlookHtml}</section>
<section><h2>Disaster / incident timeline context</h2><div class="notice warn"><p><b>Availability:</b> ${htmlEscape(report.disasterTimeline.status)}</p><p>${htmlEscape(report.disasterTimeline.summary)}</p><p>${htmlEscape(report.disasterTimeline.caveat)}</p>${report.disasterTimeline.source ? `<p><b>Source:</b> ${sourceHtml(report.disasterTimeline.source)}</p>` : ""}</div>${incidentTable}</section>
<section><h2>Methodology and caveats</h2><h3>Evidence route</h3><ul>${report.methodology.evidenceRoute.map((step) => `<li>${htmlEscape(step)}</li>`).join("")}</ul><h3>Caveats</h3><ul>${report.methodology.caveats.map((caveat) => `<li>${htmlEscape(caveat)}</li>`).join("")}</ul></section>
<section><h2>Research sources</h2><ul>${report.sources.length > 0 ? report.sources.map((source) => `<li><b>${htmlEscape(source.category)}:</b> ${sourceHtml(source)}${source.detail ? ` — ${htmlEscape(source.detail)}` : ""}</li>`).join("") : "<li>No linked sources were supplied.</li>"}</ul></section>
<footer class="meta">This report records evidence available at generation time. It is not a substitute for official emergency warnings, local ground observation, or a validated operational model.</footer>
</main></body></html>`;
}

export function renderResearchReportJson(report: ResearchReportDocument) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function createResearchReportFilename(report: ResearchReportDocument, format: ResearchReportFormat) {
  const details = FORMAT_DETAILS[format];
  const aoiSlug = report.investigation.areaOfInterest.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 42) || "aoi";
  const date = report.generatedAt.slice(0, 10);
  return `aletheopsis-research-${aoiSlug}-${date}-${report.reportId.toLowerCase()}.${details.extension}`;
}

/**
 * Build and download a Blob entirely in the browser. Returns report metadata so
 * a UI can show a toast or attach the record to query history.
 */
export function downloadResearchReport(
  input: ResearchReportInput,
  format: ResearchReportFormat = "html",
): ResearchReportDownload {
  const report = buildResearchReport(input);
  const details = FORMAT_DETAILS[format];
  const contents = format === "html"
    ? renderResearchReportHtml(report)
    : format === "markdown"
      ? renderResearchReportMarkdown(report)
      : renderResearchReportJson(report);
  const filename = createResearchReportFilename(report, format);

  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
    throw new Error("Research report download is available only in a browser.");
  }

  const url = URL.createObjectURL(new Blob([contents], { type: details.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);

  return { report, filename, format, mimeType: details.mimeType };
}

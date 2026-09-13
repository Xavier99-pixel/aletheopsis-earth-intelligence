import { AlertTriangle, CheckCircle2, Clock3, CloudSun, Database, Droplets, FileWarning, LoaderCircle, MapPinned, Radar, Ruler, ScanSearch, ShieldCheck, Siren, ThermometerSun, Waves, Wind } from "lucide-react";
import type { InvestigationBrief } from "../lib/investigationEngine";
import type { CatalogAssessment, CatalogScene, InvestigationRequest } from "../lib/types";
import { isWeatherQuestion, type RainfallOutlook } from "../services/weather";
import type { DisasterTimeline } from "../services/disasterTimeline";
import type { SelectedWindowWeather } from "../services/weatherTimeline";
import { ConversationPanel } from "./ConversationPanel";
import { ResearchReportDownload } from "./ResearchReportDownload";

type AnalysisPanelProps = {
  result: CatalogAssessment | null;
  brief: InvestigationBrief | null;
  request: InvestigationRequest | null;
  rainfallOutlook: RainfallOutlook | null;
  selectedWindowWeather: SelectedWindowWeather | null;
  disasterTimeline: DisasterTimeline | null;
  onUseQuestion?: (question: string) => void;
  running: boolean;
  error: string | null;
};

function formatRecordTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date);
}

function formatSceneTime(scene: CatalogScene) {
  return formatRecordTime(scene.datetime);
}

function formatFreshness(hours?: number) {
  if (hours === undefined) return "Timestamp unavailable";
  if (hours < 1) return "Acquired under 1 hour ago";
  if (hours < 48) return `Acquired ${Math.round(hours)} hours ago`;
  return `Acquired ${Math.round(hours / 24)} days ago`;
}

function formatWeatherDay(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function weatherDirectAnswer(outlook: RainfallOutlook) {
  const current = outlook.current;
  const currentLine = current?.temperatureCelsius === undefined
    ? "A live current-condition reading was not returned."
    : `Current conditions are ${current.temperatureCelsius.toFixed(1)}°C and ${current.condition.toLowerCase()}${current.humidityPercent === undefined ? "" : `, with ${Math.round(current.humidityPercent)}% humidity`}.`;
  return `${currentLine} ${outlook.detail} ${outlook.caveat}`;
}

function evidenceIcon(kind: InvestigationBrief["evidence"][number]["kind"]) {
  if (kind === "geometry") return <Ruler size={14} />;
  if (kind === "catalogue") return <Database size={14} />;
  if (kind === "quality") return <CheckCircle2 size={14} />;
  return <FileWarning size={14} />;
}

function stepIcon(state: InvestigationBrief["plan"]["steps"][number]["state"]) {
  if (state === "complete") return <CheckCircle2 size={14} />;
  if (state === "needs-imagery") return <ScanSearch size={14} />;
  if (state === "withheld") return <ShieldCheck size={14} />;
  return <Radar size={14} />;
}

function moduleIcon(id: InvestigationBrief["analysisReadiness"][number]["id"]) {
  if (id === "measure") return <Ruler size={15} />;
  if (id === "vegetation") return <Waves size={15} />;
  if (id === "flood") return <Droplets size={15} />;
  if (id === "objects") return <ScanSearch size={15} />;
  return <Radar size={15} />;
}

export function AnalysisPanel({
  result,
  brief,
  request,
  rainfallOutlook,
  selectedWindowWeather,
  disasterTimeline,
  onUseQuestion,
  running,
  error,
}: AnalysisPanelProps) {
  if (running) {
    return (
      <aside className="assessment-panel assessment-panel--loading" aria-live="polite">
        <LoaderCircle className="spin" size={23} />
        <span className="panel-title">Intelligence brief</span>
        <h2>Checking source evidence</h2>
        <p>Finding acquisitions, calculating the AOI geometry, and preparing a source-aware response.</p>
      </aside>
    );
  }

  if (error) {
    return (
      <aside className="assessment-panel assessment-panel--empty" aria-live="polite">
        <AlertTriangle size={23} />
        <span className="panel-title">Source connection</span>
        <h2>Investigation could not run</h2>
        <p>{error}</p>
      </aside>
    );
  }

  if (!result || !brief || !request) {
    return (
      <aside className="assessment-panel assessment-panel--empty">
        <Radar size={23} />
        <span className="panel-title">Intelligence brief</span>
        <h2>Ask a question, then run it</h2>
        <p>Search a place, set the time range, and ask about flood screening, vegetation, change, measurements, or source availability.</p>
      </aside>
    );
  }

  const quality = brief.catalogue.latestOpticalCloudCover;
  const outlookClass = rainfallOutlook ? `outlook-card--${rainfallOutlook.watchLevel}` : "outlook-card--withheld";
  const weatherQuestion = isWeatherQuestion(request.question);
  const directAnswer = weatherQuestion && rainfallOutlook ? weatherDirectAnswer(rainfallOutlook) : brief.descriptiveResponse;
  const summary = weatherQuestion && rainfallOutlook
    ? `Live atmospheric assessment prepared for ${request.aoi.name}. Satellite catalogue metadata remains available separately for the selected area and dates.`
    : brief.naturalLanguageSummary;
  const reportTimeline = disasterTimeline ? {
    status: disasterTimeline.status,
    summary: disasterTimeline.summary,
    source: { label: disasterTimeline.providerName, url: disasterTimeline.providerUrl },
    events: disasterTimeline.events.map((event) => ({
      id: event.id,
      date: event.date,
      title: event.title,
      summary: event.detail,
      category: event.category,
      severity: event.severity,
      source: { label: event.sourceName, url: event.sourceUrl },
    })),
    caveat: disasterTimeline.note,
  } : null;
  const additionalSources = [
    ...(selectedWindowWeather ? [{
      label: "Selected-window atmospheric record",
      detail: `${selectedWindowWeather.label}: ${selectedWindowWeather.detail} ${selectedWindowWeather.caveat}`,
    }] : []),
    ...(rainfallOutlook ? rainfallOutlook.provenance.map((record) => ({
      label: record.product,
      detail: `${record.role}; retrieved ${formatRecordTime(record.retrievedAt)}.`,
    })) : []),
  ];

  return (
    <aside className="assessment-panel" aria-live="polite">
      <div className="assessment-panel__top">
        <span className={`assessment-status assessment-status--${result.state}`}>{result.stateLabel}</span>
        <span className="assessment-time"><Clock3 size={13} /> {new Date(result.queriedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>

      <h2>Earth intelligence brief</h2>
      <p className="question-echo">“{brief.question}”</p>
      <p className="assessment-summary">{summary}</p>

      <section className="assessment-section intelligence-answer">
        <span className="section-label">Direct answer</span>
        <p>{directAnswer}</p>
      </section>

      <ConversationPanel
        request={request}
        brief={brief}
        scenes={result.scenes}
        rainfallOutlook={rainfallOutlook}
        timeline={disasterTimeline}
        onUseQuestion={onUseQuestion}
      />

      <section className="assessment-section">
        <span className="section-label">Atmospheric outlook</span>
        {rainfallOutlook ? (
          <div className={`outlook-card outlook-card--expanded ${outlookClass}`}>
            <div className="outlook-card__title"><CloudSun size={17} /><strong>{rainfallOutlook.label}</strong><small>{rainfallOutlook.locationTimezone ?? "Local time"}</small></div>
            <div className="atmospheric-current">
              <div><ThermometerSun size={15} /><span>Now</span><strong>{rainfallOutlook.current?.temperatureCelsius === undefined ? "—" : `${rainfallOutlook.current.temperatureCelsius.toFixed(1)}°C`}</strong><small>{rainfallOutlook.current?.condition ?? "Current condition unavailable"}</small></div>
              <div><Droplets size={15} /><span>Rain / 7 days</span><strong>{rainfallOutlook.totalMillimetres.toFixed(1)} mm</strong><small>{rainfallOutlook.peakProbability}% highest probability</small></div>
              <div><Wind size={15} /><span>Wind now</span><strong>{rainfallOutlook.current?.windKilometresPerHour === undefined ? "—" : `${rainfallOutlook.current.windKilometresPerHour.toFixed(1)} km/h`}</strong><small>{rainfallOutlook.current?.humidityPercent === undefined ? "Humidity unavailable" : `${Math.round(rainfallOutlook.current.humidityPercent)}% humidity`}</small></div>
            </div>
            <div className="forecast-days" aria-label="Seven-day weather forecast">
              {rainfallOutlook.dailyForecast.slice(0, 7).map((day) => (
                <div className="forecast-day" key={day.date}>
                  <span>{formatWeatherDay(day.date)}</span>
                  <strong>{day.precipitationMillimetres.toFixed(1)} mm</strong>
                  <small>{day.precipitationProbability}% · {day.condition}</small>
                  {day.temperatureMinimumCelsius !== undefined && day.temperatureMaximumCelsius !== undefined && <em>{day.temperatureMinimumCelsius.toFixed(0)}–{day.temperatureMaximumCelsius.toFixed(0)}°</em>}
                </div>
              ))}
            </div>
            {(rainfallOutlook.recentRainfall || rainfallOutlook.climatePattern) && (
              <div className="climate-pattern">
                {rainfallOutlook.recentRainfall && <span><b>Recent {rainfallOutlook.recentRainfall.sampledDays}-day rainfall</b>{rainfallOutlook.recentRainfall.totalMillimetres.toFixed(1)} mm · {rainfallOutlook.recentRainfall.rainyDays} rainy days</span>}
                {rainfallOutlook.climatePattern && <span><b>{rainfallOutlook.climatePattern.month} climate baseline</b>~{rainfallOutlook.climatePattern.estimatedMonthlyPrecipitationMillimetres.toFixed(1)} mm/month · {rainfallOutlook.climatePattern.meanTemperatureCelsius.toFixed(1)}°C mean</span>}
              </div>
            )}
            <small className="outlook-card__caveat">{rainfallOutlook.caveat}</small>
          </div>
        ) : (
          <div className={outlookClass}>
            <strong>Atmospheric data temporarily unavailable</strong>
            <span>The satellite catalogue review is available, but the current weather forecast did not return a usable location record. Re-run this investigation shortly.</span>
          </div>
        )}
      </section>

      {(selectedWindowWeather || disasterTimeline) && (
        <section className="assessment-section disaster-context">
          <span className="section-label">Selected-window disaster context</span>
          {selectedWindowWeather && (
            <div className={`incident-context-card incident-context-card--${selectedWindowWeather.status}`}>
              <div><Waves size={16} /><strong>{selectedWindowWeather.label}</strong></div>
              <span>{selectedWindowWeather.detail}</span>
              <small>{selectedWindowWeather.caveat}</small>
            </div>
          )}
          {disasterTimeline && (
            <div className={`incident-context-card incident-context-card--${disasterTimeline.status}`}>
              <div><Siren size={16} /><strong>Reported incident timeline</strong></div>
              <span>{disasterTimeline.summary}</span>
              <small>{disasterTimeline.note}</small>
            </div>
          )}
          {disasterTimeline?.events.slice(0, 5).map((event) => (
            <div className="incident-row" key={event.id}>
              <div>
                <strong>{event.title}</strong>
                <small>{formatRecordTime(event.date)}</small>
              </div>
              <div className="incident-row__meta">
                <span>{event.category}</span>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="assessment-section">
        <span className="section-label">Deterministic GIS measurement</span>
        <div className="measurement-grid">
          <div className="measurement-card"><MapPinned size={16} /><span>Selected AOI</span><strong>{brief.measurements.formattedArea}</strong><small>Bounding-box area</small></div>
          <div className="measurement-card"><Ruler size={16} /><span>Perimeter</span><strong>{brief.measurements.formattedPerimeter}</strong><small>Geodesic estimate</small></div>
          <div className="measurement-card"><Radar size={16} /><span>Scene freshness</span><strong>{brief.catalogue.freshness}</strong><small>{formatFreshness(brief.catalogue.latestAgeHours)}</small></div>
          <div className="measurement-card"><Database size={16} /><span>Source mix</span><strong>{brief.catalogue.opticalScenes} / {brief.catalogue.sarScenes}</strong><small>Optical / SAR scenes</small></div>
        </div>
      </section>

      <section className="assessment-section">
        <span className="section-label">Observation quality</span>
        <div className="quality-summary">
          <div><span>Latest acquisition</span><strong>{result.title.replace("Latest acquisition: ", "")}</strong></div>
          <div><span>Optical cloud metadata</span><strong>{quality === undefined ? "Not returned" : `${quality.toFixed(1)}% cloud`}</strong></div>
        </div>
      </section>

      <section className="assessment-section">
        <span className="section-label">Evidence-led analysis modules</span>
        <div className="analysis-module-grid">
          {brief.analysisReadiness.map((module) => (
            <article className={`analysis-module analysis-module--${module.state}`} key={module.id}>
              <div className="analysis-module__heading">{moduleIcon(module.id)}<strong>{module.label}</strong><small>{module.stateLabel}</small></div>
              <b>{module.output}</b>
              <span>{module.evidence}</span>
              {module.sourceSceneIds.length > 0 && <em>{module.sourceSceneIds.join(" · ")}</em>}
              <p>{module.method}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="assessment-section">
        <span className="section-label">Evidence route</span>
        <div className="processing-plan">
          {brief.plan.steps.map((step) => (
            <div className={`plan-step plan-step--${step.state}`} key={step.id}>
              {stepIcon(step.state)}
              <div><strong>{step.label}</strong><small>{step.detail}</small></div>
            </div>
          ))}
        </div>
      </section>

      <section className="assessment-section">
        <span className="section-label">Traceable evidence</span>
        <div className="evidence-list">
          {brief.evidence.slice(0, 5).map((item) => (
            <div className={`evidence-item evidence-item--${item.kind}`} key={`${item.label}-${item.value}`}>
              {evidenceIcon(item.kind)}
              <span>{item.label}</span>
              <small>{item.value}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="assessment-section acquisition-list">
        <span className="section-label">Recent acquisitions</span>
        {result.scenes.length === 0 && <p className="no-scenes">No STAC items returned for this selection.</p>}
        {result.scenes.slice(0, 3).map((scene) => (
          <div className="acquisition-row" key={scene.id}>
            <div>
              <strong>{scene.collection === "sentinel-1-grd" ? "Sentinel-1 GRD" : "Sentinel-2 L2A"}</strong>
              <small>{formatSceneTime(scene)}</small>
            </div>
            <div className="acquisition-row__meta">
              {scene.cloudCover !== undefined && <span>{scene.cloudCover.toFixed(1)}% cloud</span>}
              {scene.polarizations.length > 0 && <span>{scene.polarizations.join("/")}</span>}
            </div>
          </div>
        ))}
      </section>

      <section className="assessment-section assessment-section--export">
        <span className="section-label">Research record</span>
        <ResearchReportDownload
          input={{
            request,
            assessment: result,
            brief,
            rainfallOutlook,
            disasterTimeline: reportTimeline,
            additionalSources,
          }}
          disabled={false}
        />
      </section>
    </aside>
  );
}

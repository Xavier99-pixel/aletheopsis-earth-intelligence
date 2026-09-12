import { AlertTriangle, CheckCircle2, Clock3, Database, ExternalLink, FileWarning, LoaderCircle, MapPinned, Radar, Ruler, ScanSearch, ShieldCheck, Siren, Waves } from "lucide-react";
import type { InvestigationBrief } from "../lib/investigationEngine";
import type { CatalogAssessment, CatalogScene, InvestigationRequest } from "../lib/types";
import type { RainfallOutlook } from "../services/weather";
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
  const additionalSources = selectedWindowWeather ? [{
    label: `${selectedWindowWeather.source} selected-window rainfall`,
    url: "https://open-meteo.com/",
    detail: `${selectedWindowWeather.label}: ${selectedWindowWeather.detail} ${selectedWindowWeather.caveat}`,
  }] : [];

  return (
    <aside className="assessment-panel" aria-live="polite">
      <div className="assessment-panel__top">
        <span className={`assessment-status assessment-status--${result.state}`}>{result.stateLabel}</span>
        <span className="assessment-time"><Clock3 size={13} /> {new Date(result.queriedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>

      <h2>Earth intelligence brief</h2>
      <p className="question-echo">“{brief.question}”</p>
      <p className="assessment-summary">{brief.naturalLanguageSummary}</p>

      <section className="assessment-section intelligence-answer">
        <span className="section-label">Direct answer</span>
        <p>{brief.descriptiveResponse}</p>
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
        <span className="section-label">Predictive screening</span>
        {rainfallOutlook ? (
          <div className={`outlook-card ${outlookClass}`}>
            <div><Waves size={17} /><strong>{rainfallOutlook.label}</strong></div>
            <span>{rainfallOutlook.detail}</span>
            <small>Live weather context · {rainfallOutlook.source} · not a flood-extent prediction</small>
          </div>
        ) : (
          <div className={outlookClass}>
            <strong>Validated model not connected</strong>
            <span>{brief.predictiveResponse}</span>
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
                {event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source for ${event.title}`}><ExternalLink size={13} /></a>}
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
              {scene.stacUrl && <a href={scene.stacUrl} target="_blank" rel="noreferrer" aria-label={`Open STAC item ${scene.id}`}><ExternalLink size={13} /></a>}
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

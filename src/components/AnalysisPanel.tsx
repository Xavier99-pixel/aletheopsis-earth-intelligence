import { AlertTriangle, CheckCircle2, Clock3, Database, ExternalLink, FileWarning, LoaderCircle, Radar } from "lucide-react";
import type { CatalogAssessment, CatalogScene } from "../lib/types";

type AnalysisPanelProps = {
  result: CatalogAssessment | null;
  running: boolean;
  error: string | null;
};

function formatSceneTime(scene: CatalogScene) {
  const date = new Date(scene.datetime);
  return Number.isNaN(date.valueOf())
    ? scene.datetime
    : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date);
}

function evidenceIcon(state: "source" | "quality" | "withheld") {
  if (state === "source") return <Database size={14} />;
  if (state === "quality") return <CheckCircle2 size={14} />;
  return <FileWarning size={14} />;
}

export function AnalysisPanel({ result, running, error }: AnalysisPanelProps) {
  if (running) {
    return (
      <aside className="assessment-panel assessment-panel--loading" aria-live="polite">
        <LoaderCircle className="spin" size={23} />
        <span className="panel-title">Assessment</span>
        <h2>Retrieving source acquisitions</h2>
        <p>Searching the selected Copernicus collections for the area and date window.</p>
      </aside>
    );
  }

  if (error) {
    return (
      <aside className="assessment-panel assessment-panel--empty" aria-live="polite">
        <AlertTriangle size={23} />
        <span className="panel-title">Catalogue status</span>
        <h2>Source query unavailable</h2>
        <p>{error}</p>
      </aside>
    );
  }

  if (!result) {
    return (
      <aside className="assessment-panel assessment-panel--empty">
        <Radar size={23} />
        <span className="panel-title">Assessment</span>
        <h2>Ready for acquisition search</h2>
        <p>Set the area, source and date window, then query the public catalogue.</p>
      </aside>
    );
  }

  return (
    <aside className="assessment-panel" aria-live="polite">
      <div className="assessment-panel__top">
        <span className={`assessment-status assessment-status--${result.state}`}>{result.stateLabel}</span>
        <span className="assessment-time"><Clock3 size={13} /> {new Date(result.queriedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <h2>{result.title}</h2>
      <p className="assessment-summary">{result.summary}</p>

      <section className="assessment-section">
        <span className="section-label">Observation metrics</span>
        <div className="metrics-grid">
          {result.metrics.map((metric) => (
            <div className="metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="assessment-section forecast-block">
        <span className="section-label">Forecast</span>
        <strong>{result.forecast.label}</strong>
        <p>{result.forecast.detail}</p>
      </section>

      <section className="assessment-section">
        <span className="section-label">Evidence</span>
        <div className="evidence-list">
          {result.evidence.map((item) => (
            <div className={`evidence-item evidence-item--${item.state}`} key={item.label}>
              {evidenceIcon(item.state)}
              <span>{item.label}</span>
              <small>{item.value}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="assessment-section acquisition-list">
        <span className="section-label">Acquisitions</span>
        {result.scenes.length === 0 && <p className="no-scenes">No STAC items returned for this selection.</p>}
        {result.scenes.slice(0, 5).map((scene) => (
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
    </aside>
  );
}

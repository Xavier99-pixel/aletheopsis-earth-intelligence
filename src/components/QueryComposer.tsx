import { useEffect, useState } from "react";
import { CalendarDays, Check, Crosshair, LoaderCircle, Radar, Search } from "lucide-react";
import { GIS_TOOLS, SENSORS, type AreaOfInterest, type InvestigationRequest, type SensorId, type ToolId } from "../lib/types";
import { LocationSearch } from "./LocationSearch";

type QueryComposerProps = {
  aoi: AreaOfInterest;
  onRun: (request: InvestigationRequest) => void;
  onAoiChange: (aoi: AreaOfInterest) => void;
  running: boolean;
  suggestedQuestion?: string | null;
};

function localDate(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

export function QueryComposer({ aoi, onRun, onAoiChange, running, suggestedQuestion }: QueryComposerProps) {
  const [question, setQuestion] = useState("What is the flood outlook and available SAR evidence for this area?");
  const [sensors, setSensors] = useState<SensorId[]>(["sentinel-2", "sentinel-1"]);
  const [tools, setTools] = useState<ToolId[]>(["change", "measure"]);
  const [startDate, setStartDate] = useState(localDate(90));
  const [endDate, setEndDate] = useState(localDate(0));

  useEffect(() => {
    if (suggestedQuestion?.trim()) setQuestion(suggestedQuestion);
  }, [suggestedQuestion]);

  function toggleSensor(id: SensorId) {
    setSensors((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleTool(id: ToolId) {
    setTools((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function submit() {
    onRun({
      question: question.trim() || "Inspect latest available acquisitions for the selected area.",
      aoi,
      startDate,
      endDate,
      sensors,
      tools,
    });
  }

  return (
    <aside className="investigation-panel" aria-label="Investigation controls">
      <div className="panel-title">
        <span>Investigation</span>
        <small>Evidence route</small>
      </div>

      <div className="control-block control-block--location">
        <LocationSearch onSelect={onAoiChange} disabled={running} />
      </div>

      <label className="control-label" htmlFor="investigation-question">Question</label>
      <textarea
        id="investigation-question"
        className="investigation-question"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        rows={4}
      />

      <div className="control-block">
        <span className="control-label"><Crosshair size={14} /> Area of interest</span>
        <strong className="aoi-name">{aoi.name}</strong>
        <small>{aoi.source === "map" ? "Search result or map-selected boundary" : "Search a place or select directly on the globe"}</small>
      </div>

      <div className="control-block">
        <span className="control-label"><CalendarDays size={14} /> Acquisition window</span>
        <div className="date-stack">
          <input aria-label="Start date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <span>to</span>
          <input aria-label="End date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </div>
      </div>

      <div className="control-block">
        <span className="control-label"><Radar size={14} /> Sources</span>
        <div className="tool-stack">
          {SENSORS.map((sensor) => {
            const selected = sensors.includes(sensor.id);
            return (
              <button type="button" key={sensor.id} onClick={() => toggleSensor(sensor.id)} className={`selection-row ${selected ? "is-selected" : ""}`}>
                <span>{selected && <Check size={14} />}{sensor.name}</span>
                <small>{sensor.detail}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="control-block">
        <span className="control-label">Processing route</span>
        <div className="tool-chips">
          {GIS_TOOLS.map((tool) => {
            const selected = tools.includes(tool.id);
            return (
              <button type="button" key={tool.id} onClick={() => toggleTool(tool.id)} className={`tool-chip ${selected ? "is-selected" : ""}`}>
                {selected && <Check size={12} />} {tool.name}
              </button>
            );
          })}
        </div>
      </div>

      <button type="button" className="run-investigation" onClick={submit} disabled={running}>
        {running ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
        {running ? "Building intelligence brief" : "Run intelligence"}
      </button>
    </aside>
  );
}

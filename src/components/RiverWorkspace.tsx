import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, Calculator, Check, Database, FlaskConical, Layers, LoaderCircle, MapPin, Waves } from "lucide-react";
import type { AreaOfInterest } from "../lib/types";
import { downloadContent, downloadEvidence, researchRequest, type Calculation, type ResearchPlan, type ResearchRun } from "../services/research";
import { CesiumGlobe } from "./CesiumGlobe";
import { LocationSearch } from "./LocationSearch";
import { NewsPanel } from "./NewsPanel";
import { ScientificCalculators } from "./ScientificCalculators";
import "../styles/research.css";

export const KRISHNA_AOI: AreaOfInterest = { name: "Krishna River · Vijayawada", bbox: [80.54, 16.43, 80.69, 16.55], source: "preset" };
const today = () => new Date().toISOString().slice(0, 10);
const format = (value: number | null) => value === null ? "Not available" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
const states = ["QUEUED", "FETCHING_DATA", "PREPROCESSING", "ANALYSING", "GENERATING_OUTPUT", "COMPLETE"];

function CalculationDetails({ metric }: {metric: Calculation}) {
  return <div className="calculation-detail">
    <span className={`evidence-tag evidence-tag--${metric.evidence_level.toLowerCase()}`}>{metric.evidence_level}</span>
    <h3>{metric.label}</h3><strong className="calculation-detail__value">{format(metric.value)} <small>{metric.value === null ? "" : metric.unit}</small></strong>
    {metric.value !== null && metric.unit === "m²" && <p>Unit conversion: {format(metric.value)} ÷ 1,000,000 = {format(metric.value/1e6)} km² · {format(metric.value/10000)} hectares.</p>}
    {metric.value !== null && metric.unit === "m" && <p>Unit conversion: {format(metric.value)} ÷ 1,000 = {format(metric.value/1000)} km.</p>}
    <label>Equation</label><code>{metric.formula}</code>
    <label>Actual inputs &amp; parameters</label><pre>{JSON.stringify(metric.inputs, null, 2)}</pre>
    <label>Method</label><p>{metric.method}</p><label>Source</label><p>{Array.isArray(metric.source) ? metric.source.join("\n") : metric.source}</p>
    <label>Uncertainty &amp; limitations</label><p>{metric.uncertainty}</p>
  </div>;
}

export function RiverWorkspace({ aoi, onAoiChange }: {aoi: AreaOfInterest; onAoiChange: (aoi: AreaOfInterest) => void}) {
  const [question, setQuestion] = useState("Analyse the selected river reach between these dates. Calculate water area, shoreline length, volumetric availability and screen nearby land at the chosen distance.");
  const [dateA, setDateA] = useState("2018-10-01");
  const [dateB, setDateB] = useState(today());
  const [source, setSource] = useState<"satellite" | "geojson" | "sample">("satellite");
  const [buffer, setBuffer] = useState(2000);
  const [tolerance, setTolerance] = useState(7);
  const [upload, setUpload] = useState<{ observations: Record<string, unknown>[]; centerline?: Record<string, unknown> } | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [seed, setSeed] = useState("");
  const [capabilities, setCapabilities] = useState<{satellite_processing: boolean; research_auth: boolean} | null>(null);
  const [plan, setPlan] = useState<ResearchPlan | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [opacity, setOpacity] = useState(.55);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const operation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const result = run?.result;
  const metric = result?.calculations.find(item => item.id === selected) ?? result?.calculations[0];
  const aoiKey = aoi.bbox.join(",");

  useEffect(() => { void researchRequest<typeof capabilities>("/api/analysis/capabilities").then(setCapabilities).catch(() => setCapabilities(null)); }, []);
  useEffect(() => {
    operation.current++; abort.current?.abort(); setRun(null); setPlan(null); setBusy(false); setVisible([]); setError(null);
    return () => { operation.current++; abort.current?.abort(); };
  }, [aoiKey, dateA, dateB, source, buffer, tolerance, upload, seed]);

  async function loadFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 1_500_000) throw new Error("Use a JSON file under 1.5 MB; split larger studies into local reaches.");
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.observations) || data.observations.length === 0) throw new Error("Expected { observations: [{ date, geometry, source, scene_ids, resolution_m }] }.");
      setUpload(data); setUploadName(file.name); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Invalid observation JSON."); }
  }

  async function startAnalysis() {
    const generation = ++operation.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(null); setRun(null); setPlan(null); setVisible([]);
    try {
      const point = seed.trim() ? seed.split(",").map(value => Number(value.trim())) : null;
      if (point && (point.length !== 2 || !point.every(Number.isFinite))) throw new Error("Enter the river seed as longitude, latitude.");
      const body = { question, aoi, start_date: dateA, end_date: dateB, source_mode: source, buffer_m: buffer, search_days: tolerance,
        observations: source === "geojson" ? upload?.observations ?? [] : [], centerline: source === "geojson" ? upload?.centerline ?? null : null,
        water_seed: source === "satellite" ? point : null };
      const planned = await researchRequest<ResearchPlan>("/api/analysis/plan", body, controller.signal);
      if (generation !== operation.current) return;
      setPlan(planned);
      let current = await researchRequest<ResearchRun>("/api/analysis/river", body, controller.signal);
      const deadline = Date.now()+10*60*1000;
      while (generation === operation.current) {
        setRun(current);
        if (current.status === "FAILED") throw new Error(current.error ?? "Analysis failed without issuing results.");
        if (current.status === "COMPLETE" && current.result) {
          setSelected(current.result.metrics[0]?.id ?? null);
          const latest = current.result.temporal.at(-1)?.date;
          setVisible(current.result.layers.filter(layer => layer.id === `water_${latest}` || layer.id === `proximity_${buffer}`).map(layer => layer.id));
          break;
        }
        if (Date.now() > deadline) throw new Error(`Analysis ${current.id} is still processing. Its saved status is available through the analysis API.`);
        await new Promise(resolve => window.setTimeout(resolve, 1500));
        if (generation !== operation.current) return;
        current = await researchRequest<ResearchRun>(`/api/analysis/${current.id}`, undefined, controller.signal);
      }
    } catch (err) { if (generation === operation.current && !controller.signal.aborted) setError(err instanceof Error ? err.message : "The scientific service is unavailable."); }
    finally { if (generation === operation.current) setBusy(false); }
  }

  const exportMetrics = () => {
    if (!result) return;
    const escape = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    downloadContent(`aletheopsis-${run?.id}-metrics.csv`, [["metric", "value", "unit", "evidence", "formula", "source"],
      ...result.metrics.map(item => [item.label, item.value, item.unit, item.evidence_level, item.formula, String(item.source)])].map(row => row.map(escape).join(",")).join("\n"), "text/csv");
  };

  return <div className="research-workspace">
    <div className="research-heading"><div><span className="section-label">Research / water systems</span><h1>From source to calculation<span>.</span></h1><p>Trace every measurement. Compare dates. Understand what the evidence supports.</p></div><span className="research-heading__badge"><FlaskConical size={15} /> Auditable GIS</span></div>
    <div className="research-grid">
      <aside className="research-controls">
        <div className="research-title"><Waves size={18} /><h2>River investigation</h2></div>
        <button className="research-preset" onClick={() => onAoiChange(KRISHNA_AOI)}><MapPin size={15} /> Krishna / Vijayawada <ArrowRight size={14} /></button>
        <LocationSearch onSelect={onAoiChange} disabled={busy} />
        <p className="research-aoi">{aoi.name}<small>{aoi.bbox.map(v => v.toFixed(3)).join(" · ")} · WGS84</small></p>
        <label>Research question<textarea value={question} onChange={e => setQuestion(e.target.value)} rows={5} maxLength={2000} /></label>
        <div className="research-dates"><label>Date A<input aria-label="River Date A" type="date" value={dateA} max={dateB} onChange={e => setDateA(e.target.value)} /></label><label>Date B<input aria-label="River Date B" type="date" value={dateB} max={today()} onChange={e => setDateB(e.target.value)} /></label></div>
        <label>Source of measurements<select value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="satellite">Process Sentinel-2 imagery</option><option value="geojson">Upload dated water polygons</option><option value="sample">Synthetic calculation example</option></select></label>
        {source === "satellite" && <><p className="research-note">{capabilities?.satellite_processing ? "Pixel processing configured. Sign in to run a source-backed analysis." : "Pixel processing requires a signed-in account and Copernicus credentials on the API. You can explore the labelled example below."}</p><label>Acquisition tolerance (± days)<input type="number" min="0" max="30" value={tolerance} onChange={e => setTolerance(Number(e.target.value))} /></label><label>River seed (optional)<input value={seed} onChange={e => setSeed(e.target.value)} placeholder="80.609, 16.499" /></label><p className="research-note">Select a point inside the river to isolate its water component. Otherwise, the largest detected component is used and must be reviewed.</p></>}
        {source === "geojson" && <label>Observation JSON<input type="file" accept=".json,.geojson,application/json" onChange={e => void loadFile(e.target.files?.[0])} /><small>{uploadName || "Each observation needs a date, source and WGS84 water polygon."}</small></label>}
        {source === "sample" && <p className="research-sample"><FlaskConical size={15} /> Illustrative geometry only. Values are calculated, but do not describe the Krishna River or actual flooding.</p>}
        <label>Screening distance (metres)<input type="number" min="10" max="10000" value={buffer} onChange={e => setBuffer(Number(e.target.value))} /></label>
        <p className="research-note">Includes 500 m and 1 km zones. Distance from an observed water edge is a proximity screen, not predicted inundation.</p>
        <button className="run-investigation" disabled={busy || (source === "geojson" && !upload)} onClick={() => void startAnalysis()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Calculator size={16} />}{busy ? "Calculating…" : "Run scientific analysis"}</button>
        {source !== "sample" && <button className="research-text-button" onClick={() => setSource("sample")}>Explore a labelled calculation example</button>}
        {error && <p className="research-error" role="alert">{error}</p>}
        {run && <p className="research-run-id">Run {run.id}{run.cached ? " · Reused identical completed analysis" : ""}</p>}
        {plan && <details className="research-plan"><summary>Approved analysis plan</summary><ol>{plan.steps.map(step => <li key={step}>{step}</li>)}</ol></details>}
      </aside>
      <section className="research-center">
        <div className="research-map"><CesiumGlobe aoi={aoi} onAoiChange={onAoiChange} analysisLayers={result?.layers.filter(layer => visible.includes(layer.id))} layerOpacity={opacity} /></div>
        {busy && <div className="research-progress" role="status">{states.map((state, i) => <span key={state} className={i <= states.indexOf(run?.status ?? "QUEUED") ? "active" : ""}>{i < states.indexOf(run?.status ?? "QUEUED") ? <Check size={12} /> : <i />}{state.replaceAll("_", " ").toLowerCase()}</span>)}</div>}
        {result ? <>
          <div className="research-result-bar"><div><span className="section-label">{result.source_mode === "sample" ? "EXAMPLE · synthetic data" : "Derived measurements"}</span><h2>Calculation results</h2></div><div className="research-downloads"><button onClick={() => downloadContent(`aletheopsis-${run?.id}.json`, JSON.stringify(result, null, 2))}><ArrowDownToLine size={13} /> Report JSON</button><button onClick={exportMetrics}>CSV</button><button onClick={() => downloadContent(`aletheopsis-${run?.id}.geojson`, JSON.stringify({ type: "FeatureCollection", features: result.layers.flatMap(layer => (layer.geojson.features as Record<string, unknown>[]).map(feature => ({ ...feature, properties: { ...(feature.properties as object), layer: layer.label, evidence_level: layer.evidence_level } }))) }, null, 2))}>GeoJSON</button></div></div>
          <div className="research-metrics">{result.metrics.map(item => <article className={`research-metric ${selected === item.id ? "is-selected" : ""}`} key={item.id}><div><span className={`evidence-tag evidence-tag--${item.evidence_level.toLowerCase()}`}>{item.evidence_level}</span><small>{item.unit}</small></div><h3>{item.label}</h3><strong>{format(item.value)}</strong><button onClick={() => { setSelected(item.id); setEvidenceOpen(false); }}><Calculator size={12} /> How was this calculated?</button></article>)}</div>
          <section className="research-temporal"><span className="section-label">Dated observations</span><h3>Water extent through time</h3><p>Compare acquisition dates and valid coverage before interpreting a trend.</p><div>{result.temporal.map(item => <div key={item.date}><span>{item.date}</span><i style={{ width: `${Math.max(2, 100*item.water_area_m2/Math.max(...result.temporal.map(t => t.water_area_m2)))}%` }} /><strong>{format(item.water_area_m2/1e6)} km²</strong></div>)}</div></section>
          <section className="research-limitations"><h3>What this analysis can support</h3><ul>{result.limitations.map(item => <li key={item}>{item}</li>)}</ul></section>
        </> : <div className="research-empty"><Calculator size={26} /><h2>Calculations you can inspect.</h2><p>Run an analysis to see actual values, equations, source inputs and map layers. Results that require bathymetry or a validated flood model remain explicitly unavailable.</p><div><span>01 / Select evidence</span><span>02 / Calculate in metres</span><span>03 / Review every result</span></div></div>}
        <ScientificCalculators />
        <NewsPanel aoi={aoi} />
      </section>
      <aside className="research-ledger"><div className="research-title"><Database size={17} /><h2>Evidence &amp; ledger</h2></div>
        {result ? <>
          <div className="research-ledger-tabs"><button className={!evidenceOpen ? "active" : ""} onClick={() => setEvidenceOpen(false)}>Calculation</button><button className={evidenceOpen ? "active" : ""} onClick={() => setEvidenceOpen(true)}>Source evidence</button></div>
          {!evidenceOpen && metric && <CalculationDetails metric={metric} />}
          {evidenceOpen && <div className="research-evidence"><h3>Source evidence</h3>{result.evidence.length === 0 ? <p>{result.source_mode === "sample" ? "Synthetic geometry. No satellite acquisition or source pixels were used." : "Measurements use uploaded geometries. Source-pixel evidence was not uploaded or independently verified."}</p> : result.evidence.map(item => <article key={item.label}><strong>Observation {item.label} · {item.acquisition_date}</strong><p>Requested: {item.requested_date}</p><a href={item.source_url} target="_blank" rel="noreferrer">{item.source}</a><p>{item.contributing_tile_ids.join("\n")}</p>{Object.entries(item.assets).map(([kind, path]) => <button key={kind} onClick={() => void downloadEvidence(path, path.split("/").at(-1)!).catch(err => setError(String(err)))}><ArrowDownToLine size={13} /> {kind === "source" ? "Source bands · GeoTIFF" : kind === "mask" ? "Classified mask · GeoTIFF" : "Metadata & hashes"}</button>)}<details><summary>Pixel processing details</summary><pre>{JSON.stringify(item.processing, null, 2)}</pre></details></article>)}<details><summary>Full provenance</summary><pre>{JSON.stringify(result.provenance, null, 2)}</pre></details></div>}
          <div className="research-layer-list"><h3><Layers size={15} /> Map layers</h3><label className="research-opacity">Layer opacity<input type="range" min="0.1" max="0.9" step="0.05" value={opacity} onChange={e => setOpacity(Number(e.target.value))} /></label>{result.layers.map(layer => <label key={layer.id}><input type="checkbox" checked={visible.includes(layer.id)} onChange={() => setVisible(items => items.includes(layer.id) ? items.filter(id => id !== layer.id) : [...items, layer.id])} /><span>{layer.label}<small>{layer.evidence_level}</small></span></label>)}</div>
        </> : <div className="research-ledger-empty"><div className="research-ledger-chain">SOURCE <ArrowRight size={12} /> INPUT <ArrowRight size={12} /> RESULT</div><p>Select “How was this calculated?” on any result to inspect its equation, exact parameters, units, source and uncertainty.</p><dl><dt>Observed</dt><dd>Sensor or authoritative observation</dd><dt>Derived</dt><dd>Calculation from supplied evidence</dd><dt>Modelled / predicted</dt><dd>Requires validated models and inputs</dd><dt>Example</dt><dd>Synthetic teaching geometry</dd></dl></div>}
      </aside>
    </div>
  </div>;
}

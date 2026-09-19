import { useEffect, useState } from "react";
import { ArrowLeft, Database, FileCheck2, Landmark, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { downloadContent, researchRequest } from "../services/research";
import "../styles/government.css";

type Session = {department_id: string; role: string; can_import: boolean; can_observe: boolean};
type Parcel = {id: string; parcel_reference: string; survey_number: string; ownership_type: string; district: string; area_m2: number;
  distance_to_bank_m?: number; authorized_coverage_pct?: number; legal_status?: string; observation_status?: string;
  potential_unregistered_area_m2?: number | null; source: Record<string, unknown>; authorization_records?: Record<string, unknown>[]};
type MonitorResult = {analysis_id: string; parcels: Parcel[]; calculation: Record<string, unknown>; limitations: string[]};
const today = () => new Date().toISOString().slice(0,10);
const display = (value?: number | null) => value === undefined || value === null ? "Not assessed" : new Intl.NumberFormat("en-IN", {maximumFractionDigits: 2}).format(value);

export function GovernmentPanel({ onClose }: {onClose?: () => void}) {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [result, setResult] = useState<MonitorResult | null>(null);
  const [distance, setDistance] = useState(500);
  const [asOf, setAsOf] = useState(today());
  const [bankDate, setBankDate] = useState(today());
  const [bankline, setBankline] = useState<Record<string, unknown> | null>(null);
  const [bankName, setBankName] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [recordId, setRecordId] = useState("");
  const [license, setLicense] = useState("");
  const [importType, setImportType] = useState("parcels");
  const [importText, setImportText] = useState("");

  async function connect() {
    setBusy(true); setError(null);
    try {
      const verified = await researchRequest<Session>("/api/land/session");
      setSession(verified);
      if (!verified.can_import && verified.can_observe) setImportType("observations");
      const data = await researchRequest<{parcels: Parcel[]}>("/api/land/parcels"); setParcels(data.parcels);
    } catch (err) { setSession(null); setParcels([]); setError(err instanceof Error ? err.message : "Government access is unavailable."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void connect(); }, []);

  async function loadBank(file?: File) {
    if (!file) return;
    try {
      if (file.size > 800_000) throw new Error("Use a bankline GeoJSON file smaller than 800 KB.");
      const data = JSON.parse(await file.text());
      const geometry = data.type === "Feature" ? data.geometry : data;
      if (!["LineString", "MultiLineString"].includes(geometry?.type)) throw new Error("Provide a LineString or MultiLineString bankline, as a geometry or one Feature.");
      setBankline(geometry); setBankName(file.name); setResult(null); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Invalid bankline file."); }
  }

  async function monitor() {
    setBusy(true); setError(null); setNotice(null); setResult(null);
    try {
      const data = await researchRequest<MonitorResult>("/api/land/monitor", { bankline, distance_m: distance, as_of: asOf,
        bankline_date: bankDate, bankline_source: {name: sourceName, record_id: recordId, retrieved_at: today(), license} });
      setResult(data);
    } catch (err) { setError(err instanceof Error ? err.message : "The corridor could not be monitored."); }
    finally { setBusy(false); }
  }

  async function importRecords() {
    setBusy(true); setError(null); setNotice(null);
    try {
      if (importText.length > 1_800_000) throw new Error("Import is too large. Split it into smaller batches.");
      const data = JSON.parse(importText);
      const response = await researchRequest<Record<string, unknown>>(`/api/land/${importType}`, data);
      setNotice(`Record import saved and audited. ${JSON.stringify(response)}`); setImportText("");
      const list = await researchRequest<{parcels: Parcel[]}>("/api/land/parcels"); setParcels(list.parcels); setResult(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Import failed."); }
    finally { setBusy(false); }
  }

  return <div className="government-workspace">
    <header className="government-heading"><div><span className="section-label">Government / land revenue</span><h1>Department land monitor<span>.</span></h1><p>Compare river proximity, dated records and observed use with an auditable decision trail.</p></div><button onClick={onClose}><ArrowLeft size={14} /> Earth workspace</button></header>
    {!session ? <section className="government-gate"><LockKeyhole size={32} /><h2>Verified government access</h2><p>Sign in with a department-provisioned account. The server checks your assigned role and department before opening land records.</p><p>A selected operating profile or demonstration login does not grant government permissions.</p>{error && <p className="research-error" role="alert">{error}</p>}<button disabled={busy} onClick={() => void connect()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? "Verifying access…" : "Verify access again"}</button><small>Setup requires Supabase government role provisioning and the PostGIS land-record migration. No sample land records are presented as official data.</small></section> : <>
      <div className="government-session"><span><ShieldCheck size={15} /> {session.department_id}</span><span>{session.role.replaceAll("_", " ")}</span><span>Server-verified access</span><button onClick={() => void connect()} disabled={busy}><RefreshCw size={13} /> Refresh records</button></div>
      {error && <p className="research-error" role="alert">{error}</p>}{notice && <p className="government-notice" role="status">{notice}</p>}
      <div className="government-grid"><section className="government-card"><div className="research-title"><Landmark size={19} /><h2>Monitor a river corridor</h2></div><p>Upload a dated observed bankline and select a monitoring distance. This is not a flood prediction or a statutory setback.</p><label>Observed bankline · GeoJSON<input type="file" accept=".json,.geojson" onChange={e => void loadBank(e.target.files?.[0])} /><small>{bankName || "LineString / MultiLineString in WGS84"}</small></label><div className="government-fields"><label>Bankline date<input type="date" value={bankDate} max={asOf} onChange={e => {setBankDate(e.target.value);setResult(null);}} /></label><label>Check records as of<input type="date" value={asOf} max={today()} onChange={e => {setAsOf(e.target.value);setResult(null);}} /></label><label>Distance (metres)<input type="number" min="1" max="10000" value={distance} onChange={e => {setDistance(Number(e.target.value));setResult(null);}} /></label></div><label>Bankline source / department<input value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="Name of the source dataset" /></label><label>Source record identifier<input value={recordId} onChange={e => setRecordId(e.target.value)} placeholder="Dataset or analysis reference" /></label><label>Licence / permitted use<input value={license} onChange={e => setLicense(e.target.value)} placeholder="Department-approved use terms" /></label><button className="run-investigation" disabled={busy || !bankline || !sourceName.trim() || !recordId.trim() || !license.trim()} onClick={() => void monitor()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FileCheck2 size={16} />}Check corridor records</button></section>
        <section className="government-card"><div className="research-title"><Database size={19} /><h2>Authoritative records</h2></div><p>{parcels.length} loaded parcel records · only your department's data is accessible. Source records determine authorization status; an absent record requires verification.</p>{session.can_import || session.can_observe ? <><label>Import record type<select value={importType} onChange={e => setImportType(e.target.value)}>{session.can_import && <><option value="parcels">Parcel batch</option><option value="authorizations">Authorization record</option></>}{session.can_observe && <option value="observations">Observed built footprint</option>}</select></label><label>Record JSON<input type="file" accept=".json,application/json" onChange={e => { const file=e.target.files?.[0]; if(file){ if(file.size>1_800_000){setError("Import must be under 1.8 MB.");return;} void file.text().then(setImportText); } }} /><textarea value={importText} onChange={e => setImportText(e.target.value)} rows={9} placeholder="Paste a department-approved record using the documented import schema." /></label><p className="government-small">Every import requires source metadata, dates and valid geometry. Existing records are never silently overwritten. See docs/GOVERNMENT.md for exact schemas.</p><button className="government-button" disabled={busy || !importText.trim()} onClick={() => void importRecords()}><Upload size={14} /> Import &amp; audit record</button></> : <p>Your provisioned role has read-only access to records.</p>}</section></div>
      <section className="government-card government-results"><div className="government-results__heading"><h2>{result ? "Corridor assessment" : "Department parcel register"}</h2>{result && <button onClick={() => downloadContent(`land-monitor-${result.analysis_id}.json`, JSON.stringify(result,null,2))}>Export assessment JSON</button>}</div><p>{result ? `Analysis ${result.analysis_id}` : "First 100 records. The API supports pagination for larger registers."}</p>
        {(result?.parcels ?? parcels).length === 0 ? <p>No matching records. This does not establish that land is unauthorized or free from development.</p> : <div className="government-table-wrap"><table><thead><tr><th>Parcel / survey</th><th>Ownership</th><th>Area (m²)</th>{result && <><th>Distance (m)</th><th>Status in records</th><th>Authorized footprint</th><th>Observed use</th></>}<th>Evidence</th></tr></thead><tbody>{(result?.parcels ?? parcels).map(p => <tr key={p.id}><td><strong>{p.parcel_reference}</strong><small>{p.survey_number} · {p.district}</small><small>{p.id}</small></td><td>{p.ownership_type}</td><td>{display(p.area_m2)}</td>{result && <><td>{display(p.distance_to_bank_m)}</td><td>{p.legal_status?.replaceAll("_"," ")}</td><td>{display(p.authorized_coverage_pct)}%</td><td>{p.observation_status?.replaceAll("_"," ")}<small>{p.potential_unregistered_area_m2 == null ? "No quantified observation" : `${display(p.potential_unregistered_area_m2)} m² outside active authorization footprints`}</small></td></>}<td><details><summary>View records</summary><pre>{JSON.stringify({source:p.source,authorizations:p.authorization_records},null,2)}</pre></details></td></tr>)}</tbody></table></div>}
        {result && <><details className="government-calculation"><summary>How was this calculated?</summary><pre>{JSON.stringify(result.calculation,null,2)}</pre></details><ul className="government-small">{result.limitations.map(item => <li key={item}>{item}</li>)}</ul></>}
      </section>
    </>}
  </div>;
}

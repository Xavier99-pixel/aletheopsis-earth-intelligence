import { useState } from "react";
import { Calculator, LoaderCircle } from "lucide-react";
import { downloadContent, researchRequest } from "../services/research";

const examples = {
  cross_section_volume: {label: "Channel volume · surveyed cross-sections", parameters: {chainages_m: [0,100,200], areas_m2: [20,30,40]}},
  depth_volume: {label: "Volume · bed elevation & water surface", parameters: {bed_elevation_m: [[2,3],[4,6]], water_surface_elevation_m: 5, valid_mask: [[true,true],[true,true]], pixel_area_m2: 100, bed_vertical_datum: "EXAMPLE common datum", water_vertical_datum: "EXAMPLE common datum", connected_mask: [[true,true],[true,false]]}},
  dem_difference_volume: {label: "Terrain change · DEM of difference", parameters: {before_m:[[1,2],[3,4]],after_m:[[2,2.1],[2,4]],valid_mask:[[true,true],[true,true]],pixel_area_m2:100,before_vertical_datum:"EXAMPLE common datum",after_vertical_datum:"EXAMPLE common datum",rmse_before_m:.1,rmse_after_m:.1}},
  bank_change: {label: "Water-edge rates · NSM / EPR / LRR", parameters: {samples:[{date:"2018-01-01",position_m:10,uncertainty_m:2},{date:"2020-01-01",position_m:15,uncertainty_m:2},{date:"2022-01-01",position_m:20,uncertainty_m:2}]}},
  water_index: {label: "Water index · aligned reflectance pixels", parameters: {band_a:[[.3,.4],[.1,.1]],band_b:[[.1,.1],[.4,.3]],valid_mask:[[true,true],[true,true]],index:"MNDWI",pixel_area_m2:400}},
} as const;
type Operation = keyof typeof examples;

export function ScientificCalculators() {
  const [operation, setOperation] = useState<Operation>("cross_section_volume");
  const [parameters, setParameters] = useState(JSON.stringify(examples.cross_section_volume.parameters,null,2));
  const [sample, setSample] = useState(true);
  const [source, setSource] = useState("Synthetic teaching values; not field measurements");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function calculate() {
    setBusy(true); setResult(null); setError(null);
    try { setResult(await researchRequest<Record<string,unknown>>("/api/gis/calculate", {operation,source,parameters:JSON.parse(parameters),is_sample:sample})); }
    catch(err) { setError(err instanceof Error ? err.message : "Calculation failed."); }
    finally { setBusy(false); }
  }
  return <section className="research-calculators"><details><summary><Calculator size={16} /> Scientific calculators · volume &amp; temporal rates</summary><p>Use these when you have the required measurements. Each calculation retains the supplied inputs and equation. The prefilled values are a teaching example.</p><label>Calculation<select value={operation} onChange={e => {const next=e.target.value as Operation;setOperation(next);setParameters(JSON.stringify(examples[next].parameters,null,2));setSample(true);setSource("Synthetic teaching values; not field measurements");setResult(null);}}>{Object.entries(examples).map(([key,value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><label>Input parameters · JSON<textarea rows={9} value={parameters} onChange={e => {setParameters(e.target.value);setResult(null);}} /></label><label>Measurement source<input value={source} onChange={e => {setSource(e.target.value);setResult(null);}} /></label><label className="research-calculator-sample"><input type="checkbox" checked={sample} onChange={e => {setSample(e.target.checked);setResult(null);}} /> Label as synthetic example</label><p>For real observations, enter their source and sign in. Cross-section areas must describe the same stage; DEMs and water levels must use the same vertical datum. This calculator does not run a hydraulic forecast.</p><button className="run-investigation" disabled={busy || !source.trim()} onClick={() => void calculate()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Calculator size={15} />}Calculate from supplied inputs</button>{error && <p className="research-error" role="alert">{error}</p>}{result && <div><span className="evidence-tag">{String(result.evidence_level)}</span><pre>{JSON.stringify(result,null,2)}</pre><button onClick={() => downloadContent(`aletheopsis-${operation}.json`,JSON.stringify(result,null,2))}>Download calculation &amp; inputs</button></div>}</details></section>;
}

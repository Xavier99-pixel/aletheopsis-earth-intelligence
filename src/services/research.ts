import { getAuthenticatedAccessToken } from "./auth";

export const backendBase = import.meta.env.VITE_BACKEND_BASE_URL?.replace(/\/+$/, "") || (import.meta.env.DEV ? "http://localhost:8000" : "");
export type EvidenceLevel = "OBSERVED" | "DERIVED" | "MODELLED" | "PREDICTED" | "EXAMPLE";
export type MapLayer = { id: string; label: string; evidence_level: EvidenceLevel; geojson: Record<string, unknown> };
export type Calculation = { id: string; label: string; value: number | null; unit: string; evidence_level: EvidenceLevel;
  formula: string; inputs: Record<string, unknown>; method: string; source: string | string[]; uncertainty: string };
export type ResearchEvidence = { label: string; requested_date: string; acquisition_date: string; source: string; source_url: string;
  contributing_tile_ids: string[]; assets: Record<string, string>; processing: Record<string, unknown>; sha256: Record<string, string> };
export type ResearchResult = { analysis_id: string; source_mode: string; metrics: Calculation[]; calculations: Calculation[];
  layers: MapLayer[]; temporal: { date: string; water_area_m2: number; water_edge_length_m: number }[];
  limitations: string[]; provenance: Record<string, unknown>; evidence: ResearchEvidence[]; plan: ResearchPlan };
export type ResearchPlan = { intent: string; steps: string[]; requested_dates: string[]; screening_buffers_m: number[]; requires: Record<string, string[]>; prediction_status: string };
export type ResearchRun = { id: string; status: string; created_at: string; error: string | null; result: ResearchResult | null; cached?: boolean };

export async function researchRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = await getAuthenticatedAccessToken();
  const response = await fetch(`${backendBase}${path}`, { method: body === undefined ? "GET" : "POST", signal,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("The GIS API is not connected. Configure VITE_BACKEND_BASE_URL with your Render API address.");
  const payload = await response.json();
  if (!response.ok) {
    const detail = payload.detail;
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((item: {msg: string}) => item.msg).join("; ") : "The analysis request failed.");
  }
  return payload as T;
}

export function downloadContent(filename: string, content: string | Blob, type = "application/json") {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function downloadEvidence(path: string, filename: string) {
  if (!/^\/api\/analysis\/[a-f\d-]+\/assets\/[AB]-(source|mask|metadata)\.(tif|json)$/.test(path)) throw new Error("Invalid evidence reference.");
  const token = await getAuthenticatedAccessToken();
  const response = await fetch(`${backendBase}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error("The evidence file could not be downloaded. Verify your session and server evidence storage.");
  downloadContent(filename, await response.blob());
}

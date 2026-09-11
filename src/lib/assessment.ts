import type { CatalogueSearchResult } from "../services/catalog";
import type { CatalogAssessment, CatalogScene, InvestigationRequest } from "./types";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function latestScene(scenes: CatalogScene[], collection: CatalogScene["collection"]) {
  return scenes.find((scene) => scene.collection === collection);
}

function observationState(scene: CatalogScene | undefined, hasSar: boolean): CatalogAssessment["state"] {
  if (!scene && !hasSar) return "unavailable";
  if (!scene) return "ready";
  if (scene.cloudCover === undefined) return hasSar ? "ready" : "review";
  if (scene.cloudCover <= 10) return "ready";
  if (scene.cloudCover <= 35) return "review";
  return hasSar ? "review" : "limited";
}

function stateLabel(state: CatalogAssessment["state"]) {
  if (state === "ready") return "Observation ready";
  if (state === "review") return "Quality review";
  if (state === "limited") return "Limited optical view";
  return "No acquisition found";
}

export function buildCatalogAssessment(
  request: InvestigationRequest,
  catalogue: CatalogueSearchResult,
): CatalogAssessment {
  const scenes = catalogue.items;
  const optical = latestScene(scenes, "sentinel-2-l2a");
  const sar = latestScene(scenes, "sentinel-1-grd");
  const state = observationState(optical, Boolean(sar));
  const latest = scenes[0];
  const cloud = optical?.cloudCover;
  const summary = scenes.length > 0
    ? `${scenes.length} source acquisition${scenes.length === 1 ? "" : "s"} catalogued for ${request.aoi.name}. No change, flood, object, or forecast claim is issued until the selected imagery is processed and quality checked.`
    : `No catalogue acquisitions were returned for ${request.aoi.name} in the selected time range. Widen the date window or select another source.`;

  return {
    state,
    stateLabel: stateLabel(state),
    title: latest ? `Latest acquisition: ${formatDate(latest.datetime)}` : "No acquisition available",
    summary,
    aoi: request.aoi,
    queriedAt: new Date().toISOString(),
    sourceName: catalogue.sourceName,
    sourceUrl: catalogue.sourceUrl,
    scenes,
    metrics: [
      { label: "Acquisitions", value: String(scenes.length), detail: "Selected date range" },
      { label: "Latest optical", value: optical ? formatDate(optical.datetime) : "—", detail: optical?.platform ?? "No Sentinel-2 item" },
      { label: "Cloud cover", value: cloud === undefined ? "—" : `${cloud.toFixed(1)}%`, detail: "Sentinel-2 scene metadata" },
      { label: "Latest SAR", value: sar ? formatDate(sar.datetime) : "—", detail: sar?.orbitState ?? "No Sentinel-1 item" },
    ],
    forecast: {
      label: "Forecast not issued",
      detail: "A predictive score is shown only after a calibrated, versioned model has run against validated source imagery for this AOI.",
      state: "withheld",
    },
    evidence: [
      { label: "Catalogue", value: catalogue.sourceName, state: "source" },
      latest
        ? { label: "Latest asset", value: `${latest.id} · ${formatDate(latest.datetime)}`, state: "source" }
        : { label: "Latest asset", value: "No STAC item returned", state: "withheld" },
      optical?.cloudCover !== undefined
        ? { label: "Optical quality", value: `${optical.cloudCover.toFixed(1)}% cloud cover`, state: "quality" }
        : { label: "Optical quality", value: "No cloud metric returned", state: "withheld" },
      { label: "Forecast", value: "Withheld pending validated model run", state: "withheld" },
    ],
  };
}

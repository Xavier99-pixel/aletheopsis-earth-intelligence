export const ROLES = [
  "Government official",
  "Researcher",
  "Disaster management",
  "Environmental analyst",
] as const;

export type Role = (typeof ROLES)[number];

export const SENSORS = [
  { id: "sentinel-2", name: "Sentinel-2 optical", detail: "Surface reflectance and cloud quality" },
  { id: "sentinel-1", name: "Sentinel-1 SAR", detail: "Radar observations through cloud" },
] as const;

export type SensorId = (typeof SENSORS)[number]["id"];

export const GIS_TOOLS = [
  { id: "change", name: "Change", detail: "Compare registered acquisitions" },
  { id: "ndvi", name: "Vegetation", detail: "Optical index workflow" },
  { id: "flood", name: "Flood extent", detail: "Water / SAR workflow" },
  { id: "objects", name: "Objects", detail: "Segmentation workflow" },
  { id: "measure", name: "Measure", detail: "Area, distance and topology" },
] as const;

export type ToolId = (typeof GIS_TOOLS)[number]["id"];

export type BBox = [number, number, number, number];

export type PolygonGeometry = { type: "Polygon"; coordinates: number[][][] };

export type AreaOfInterest = {
  name: string;
  bbox: BBox;
  source: "preset" | "map";
  geometry?: PolygonGeometry;
};

export type CatalogScene = {
  id: string;
  collection: "sentinel-2-l2a" | "sentinel-1-grd";
  datetime: string;
  platform?: string;
  cloudCover?: number;
  orbitState?: string;
  polarizations: string[];
  resolution?: number;
  bbox?: BBox;
  assetKeys: string[];
  stacUrl?: string;
};

export type InvestigationRequest = {
  question: string;
  aoi: AreaOfInterest;
  startDate: string;
  endDate: string;
  sensors: SensorId[];
  tools: ToolId[];
};

export type AssessmentState = "ready" | "review" | "limited" | "unavailable";

export type AssessmentMetric = {
  label: string;
  value: string;
  detail: string;
};

export type EvidenceRecord = {
  label: string;
  value: string;
  state: "source" | "quality" | "withheld";
};

export type CatalogAssessment = {
  state: AssessmentState;
  stateLabel: string;
  title: string;
  summary: string;
  aoi: AreaOfInterest;
  queriedAt: string;
  sourceName: string;
  sourceUrl: string;
  scenes: CatalogScene[];
  metrics: AssessmentMetric[];
  forecast: {
    label: string;
    detail: string;
    state: "withheld";
  };
  evidence: EvidenceRecord[];
};

export type Identity = {
  email: string;
  role: Role;
  mode: "local" | "authenticated";
};

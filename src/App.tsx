import { useEffect, useState } from "react";
import { Bell, CircleUserRound, ShieldCheck } from "lucide-react";
import { buildCatalogAssessment } from "./lib/assessment";
import { buildInvestigationBrief, type InvestigationBrief } from "./lib/investigationEngine";
import type { AreaOfInterest, CatalogAssessment, Identity, InvestigationRequest } from "./lib/types";
import { searchLiveCatalogue } from "./services/catalog";
import { finishAuthentication, getAuthenticatedIdentity, onAuthIdentityChange } from "./services/auth";
import { isWeatherQuestion, loadRainfallOutlook, type RainfallOutlook } from "./services/weather";
import { loadDisasterTimeline, type DisasterTimeline } from "./services/disasterTimeline";
import { loadSelectedWindowWeather, type SelectedWindowWeather } from "./services/weatherTimeline";
import { AccessGate } from "./components/AccessGate";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BrandMark } from "./components/BrandMark";
import { CesiumGlobe } from "./components/CesiumGlobe";
import { QueryComposer } from "./components/QueryComposer";
import { RiverWorkspace } from "./components/RiverWorkspace";
import { GovernmentPanel } from "./components/GovernmentPanel";

const defaultAoi: AreaOfInterest = {
  name: "Hyderabad Basin",
  bbox: [78.30, 17.32, 78.47, 17.49],
  source: "preset",
};

const DISASTER_QUERY = /\b(disaster(?:s)?|incident(?:s)?|calamit(?:y|ies)|flood(?:ed|ing)?|inundat(?:e|ed|ion)|cyclone|storm|earthquake|landslide|wildfire|drought|emergency)\b/i;

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [aoi, setAoi] = useState<AreaOfInterest>(defaultAoi);
  const [result, setResult] = useState<CatalogAssessment | null>(null);
  const [brief, setBrief] = useState<InvestigationBrief | null>(null);
  const [rainfallOutlook, setRainfallOutlook] = useState<RainfallOutlook | null>(null);
  const [selectedWindowWeather, setSelectedWindowWeather] = useState<SelectedWindowWeather | null>(null);
  const [disasterTimeline, setDisasterTimeline] = useState<DisasterTimeline | null>(null);
  const [lastRequest, setLastRequest] = useState<InvestigationRequest | null>(null);
  const [suggestedQuestion, setSuggestedQuestion] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoRealistic, setPhotoRealistic] = useState(false);
  const [page, setPage] = useState(window.location.pathname);

  useEffect(() => {
    const changed = () => setPage(window.location.pathname);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  function navigate(path: string) { window.history.pushState({}, "", path); setPage(path); }

  useEffect(() => {
    let active = true;
    void getAuthenticatedIdentity().then((authenticatedIdentity) => {
      if (active && authenticatedIdentity) {
        setIdentity(authenticatedIdentity);
        finishAuthentication();
      }
    });
    const unsubscribe = onAuthIdentityChange((authenticatedIdentity) => {
      if (active && authenticatedIdentity) {
        setIdentity(authenticatedIdentity);
        finishAuthentication();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function runInvestigation(request: InvestigationRequest) {
    setRunning(true);
    setError(null);
    try {
      const asksForWeather = isWeatherQuestion(request.question);
      const disasterMode = identity?.role === "Disaster management" || DISASTER_QUERY.test(request.question);
      const [catalogue, rainfall, windowWeather, timeline] = await Promise.all([
        searchLiveCatalogue(request),
        // A current atmospheric picture is useful for every investigation and
        // makes simple rainfall/weather questions immediately actionable.
        loadRainfallOutlook(request.aoi),
        asksForWeather || disasterMode
          ? loadSelectedWindowWeather(request.aoi, request.startDate, request.endDate)
          : Promise.resolve(null),
        disasterMode ? loadDisasterTimeline(request.aoi, request.startDate, request.endDate) : Promise.resolve(null),
      ]);
      setResult(buildCatalogAssessment(request, catalogue));
      setBrief(buildInvestigationBrief(request, catalogue.items));
      setRainfallOutlook(rainfall);
      setSelectedWindowWeather(windowWeather);
      setDisasterTimeline(timeline);
      setLastRequest(request);
    } catch (reason) {
      setResult(null);
      setBrief(null);
      setRainfallOutlook(null);
      setSelectedWindowWeather(null);
      setDisasterTimeline(null);
      setLastRequest(null);
      setError(reason instanceof Error ? reason.message : "The catalogue could not be reached. Check the network connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  function updateAoi(nextAoi: AreaOfInterest) {
    setAoi(nextAoi);
    setResult(null);
    setBrief(null);
    setRainfallOutlook(null);
    setSelectedWindowWeather(null);
    setDisasterTimeline(null);
    setLastRequest(null);
    setError(null);
  }

  if (!identity) return <AccessGate onAuthenticated={setIdentity} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <BrandMark compact />
        <nav className="workspace-nav" aria-label="Workspace sections">
          <button className={page !== "/research" && page !== "/admin" ? "active" : ""} onClick={() => navigate("/")}>Earth workspace</button>
          <button className={page === "/research" ? "active" : ""} onClick={() => navigate("/research")}>River research</button>
          <button className={page === "/admin" ? "active" : ""} onClick={() => navigate("/admin")}>Government</button>
        </nav>
        <div className="topbar__system">
          <span><i className="system-dot" /> Earth workspace</span>
          <span><ShieldCheck size={14} /> {identity.role}</span>
        </div>
        <div className="topbar__account">
          <button className="icon-button" type="button" aria-label="Notifications"><Bell size={17} /></button>
          <span className="account-chip"><CircleUserRound size={16} /> {identity.email}</span>
        </div>
      </header>

      {page === "/research" ? <RiverWorkspace aoi={aoi} onAoiChange={updateAoi} /> : page === "/admin" ? <GovernmentPanel onClose={() => navigate("/")} /> : <main className="command-surface">
        <QueryComposer aoi={aoi} onRun={runInvestigation} onAoiChange={updateAoi} running={running} suggestedQuestion={suggestedQuestion} />
        <div className="earth-stage">
          <CesiumGlobe
            aoi={aoi}
            scenes={result?.scenes}
            photoRealistic={photoRealistic}
            onPhotoRealisticChange={setPhotoRealistic}
            onAoiChange={updateAoi}
          />
        </div>
        <AnalysisPanel
          result={result}
          brief={brief}
          request={lastRequest}
          rainfallOutlook={rainfallOutlook}
          selectedWindowWeather={selectedWindowWeather}
          disasterTimeline={disasterTimeline}
          onUseQuestion={setSuggestedQuestion}
          running={running}
          error={error}
        />
      </main>}
    </div>
  );
}

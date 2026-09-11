import { useEffect, useState } from "react";
import { Bell, CircleUserRound, Database, ShieldCheck } from "lucide-react";
import { buildCatalogAssessment } from "./lib/assessment";
import type { AreaOfInterest, CatalogAssessment, Identity, InvestigationRequest } from "./lib/types";
import { searchLiveCatalogue } from "./services/catalog";
import { getAuthenticatedIdentity, onAuthIdentityChange } from "./services/auth";
import { AccessGate } from "./components/AccessGate";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BrandMark } from "./components/BrandMark";
import { CesiumGlobe } from "./components/CesiumGlobe";
import { QueryComposer } from "./components/QueryComposer";

const defaultAoi: AreaOfInterest = {
  name: "Hyderabad Basin",
  bbox: [78.30, 17.32, 78.47, 17.49],
  source: "preset",
};

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [aoi, setAoi] = useState<AreaOfInterest>(defaultAoi);
  const [result, setResult] = useState<CatalogAssessment | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoRealistic, setPhotoRealistic] = useState(false);

  useEffect(() => {
    let active = true;
    void getAuthenticatedIdentity().then((authenticatedIdentity) => {
      if (active && authenticatedIdentity) setIdentity(authenticatedIdentity);
    });
    const unsubscribe = onAuthIdentityChange((authenticatedIdentity) => {
      if (active && authenticatedIdentity) setIdentity(authenticatedIdentity);
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
      const catalogue = await searchLiveCatalogue(request);
      setResult(buildCatalogAssessment(request, catalogue));
    } catch (reason) {
      setResult(null);
      setError(reason instanceof Error ? reason.message : "The catalogue could not be reached. Check the network connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  function updateAoi(nextAoi: AreaOfInterest) {
    setAoi(nextAoi);
    setResult(null);
    setError(null);
  }

  if (!identity) return <AccessGate onAuthenticated={setIdentity} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <BrandMark compact />
        <div className="topbar__system">
          <span><i className="system-dot" /> Public catalogue</span>
          <span><Database size={14} /> Copernicus Data Space STAC</span>
          <span><ShieldCheck size={14} /> {identity.role}</span>
        </div>
        <div className="topbar__account">
          <button className="icon-button" type="button" aria-label="Notifications"><Bell size={17} /></button>
          <span className="account-chip"><CircleUserRound size={16} /> {identity.email}</span>
        </div>
      </header>

      <main className="command-surface">
        <QueryComposer aoi={aoi} onRun={runInvestigation} running={running} />
        <div className="earth-stage">
          <CesiumGlobe
            aoi={aoi}
            scenes={result?.scenes}
            photoRealistic={photoRealistic}
            onPhotoRealisticChange={setPhotoRealistic}
            onAoiChange={updateAoi}
          />
        </div>
        <AnalysisPanel result={result} running={running} error={error} />
      </main>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Newspaper, RefreshCw } from "lucide-react";
import type { AreaOfInterest } from "../lib/types";
import { backendBase } from "../services/research";
import "../styles/news.css";

type NewsArticle = {
  title: string;
  url: string;
  source: string;
  authority: "official_publisher" | "broader_discovery";
  published_at: string | null;
  seen_at: string | null;
  match_method: string;
  coordinates: null;
};
type NewsResult = {
  status: "ok" | "no_results" | "unavailable";
  query: string;
  category: string;
  retrieved_at: string;
  cached: boolean;
  message: string;
  note: string;
  articles: NewsArticle[];
};
type Category = "environment" | "flood" | "urban";
const resources = [
  ["PIB", "https://pib.gov.in/"],
  ["IMD", "https://mausam.imd.gov.in/"],
  ["CWC", "https://cwc.gov.in/"],
  ["NRSC", "https://www.nrsc.gov.in/"],
  ["NDMA", "https://ndma.gov.in/"],
] as const;

function publicLink(value: unknown): value is string {
  if (typeof value !== "string" || /[\s\\\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.hostname.includes(".");
  } catch { return false; }
}

function newsDate(value: string | null) {
  if (!value) return "Provider timestamp unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Provider timestamp unavailable" : `Seen by GDELT ${parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function NewsPanel({ aoi }: { aoi: AreaOfInterest }) {
  const [location, setLocation] = useState(aoi.name.slice(0, 120));
  const [category, setCategory] = useState<Category>("environment");
  const [result, setResult] = useState<NewsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    setLocation(aoi.name.slice(0, 120));
    setResult(null);
    setError(null);
    setLoading(false);
    return () => controller.current?.abort();
  }, [aoi.name]);

  async function refreshNews() {
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError(null);
    setResult(null);
    const timeout = window.setTimeout(() => requestController.abort(), 22000);
    try {
      const params = new URLSearchParams({ query: location.trim(), category });
      const response = await fetch(`${backendBase}/api/news/geospatial?${params}`, { signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 422 ? "Enter a valid place name to search." : "The news service is unavailable. Check the backend connection and try again.");
      const payload: NewsResult = await response.json();
      if (!Array.isArray(payload.articles) || !["ok", "no_results", "unavailable"].includes(payload.status)) throw new Error("The news service returned an unreadable response.");
      if (controller.current !== requestController || requestController.signal.aborted) return;
      setResult({ ...payload, articles: payload.articles.filter((article) => publicLink(article.url) && typeof article.title === "string") });
    } catch (caught) {
      if (controller.current !== requestController) return;
      setError(requestController.signal.aborted ? "News request timed out. Refresh to try again." : caught instanceof Error ? caught.message : "News could not be retrieved.");
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === requestController) setLoading(false);
    }
  }

  return (
    <section className="news-panel" aria-labelledby="news-heading">
      <div className="news-panel__heading"><Newspaper size={18} /><div><span className="section-label">Source-linked context</span><h2 id="news-heading">Environment &amp; urban news</h2></div><span className="news-panel__window">Last 30 days</span></div>
      <p className="news-panel__intro">Find reporting around a place name. Each result opens the original publisher.</p>
      <form className="news-panel__controls" onSubmit={(event) => { event.preventDefault(); void refreshNews(); }}>
        <label>Place name<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={120} minLength={2} required placeholder="Vijayawada" /></label>
        <label>Topic<select value={category} onChange={(event) => setCategory(event.target.value as Category)}><option value="environment">Environment</option><option value="flood">Flood &amp; water</option><option value="urban">Urban planning</option></select></label>
        <button type="submit" disabled={loading || location.trim().length < 2}>{loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{loading ? "Finding reports…" : "Refresh news"}</button>
      </form>
      <div aria-live="polite" className="news-panel__status">
        {error && <p className="news-panel__error">{error}</p>}
        {result && <p className={result.status === "unavailable" ? "news-panel__error" : ""}>{result.message}{result.cached ? " Showing a cached response (up to 5 minutes)." : ""}</p>}
        {!result && !error && !loading && <p>Choose Refresh news to search GDELT. No news request runs automatically.</p>}
      </div>
      {result && result.articles.length > 0 && <><p className="news-panel__scope">Results for <strong>{result.query}</strong> · {result.category}</p><ul className="news-panel__articles">{result.articles.map((article) => <li key={article.url}>
        <div className="news-panel__article-meta"><span>{article.source}</span><span className={`news-panel__authority news-panel__authority--${article.authority}`}>{article.authority === "official_publisher" ? "Official publisher" : "News discovery"}</span></div>
        <a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<ExternalLink size={13} aria-label="Opens publisher in a new tab" /></a>
        <small>{newsDate(article.seen_at)} · Text match · Location unverified</small>
      </li>)}</ul></>}
      <p className="news-panel__note">{result?.note ?? "Text matches do not establish that an event occurred inside your map area. Reports have no verified coordinates and are not plotted. News is context, not a flood forecast or a land-authorisation record."}</p>
      <div className="news-panel__resources"><span>Official reference portals</span><nav aria-label="Official environment and disaster reference portals">{resources.map(([name, url]) => <a key={name} href={url} target="_blank" rel="noopener noreferrer">{name}<ExternalLink size={11} /></a>)}</nav><small>Reference links, separate from retrieved news articles.</small></div>
    </section>
  );
}

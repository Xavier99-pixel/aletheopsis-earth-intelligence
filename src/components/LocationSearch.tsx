import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, MapPin, Search, X } from "lucide-react";
import type { AreaOfInterest } from "../lib/types";
import { searchLocations, type LocationSearchResult } from "../services/geocoding";

type SearchState = "idle" | "loading" | "ready" | "empty" | "error";

export type LocationSearchProps = {
  /** Receives an AreaOfInterest which can be passed directly to App.updateAoi. */
  onSelect: (aoi: AreaOfInterest) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  debounceMs?: number;
};

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * An accessible, debounced location search which returns an AreaOfInterest.
 * It does not submit a satellite query itself; the parent owns that workflow.
 */
export function LocationSearch({
  onSelect,
  label = "Find a location",
  placeholder = "Search city, district, address or landmark",
  className = "",
  disabled = false,
  debounceMs = 500,
}: LocationSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [state, setState] = useState<SearchState>("idle");
  const [message, setMessage] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();
  const requestSequence = useRef(0);
  const suppressSearchForQuery = useRef<string | null>(null);

  useEffect(() => {
    if (suppressSearchForQuery.current === query) {
      suppressSearchForQuery.current = null;
      return undefined;
    }
    const value = query.trim();
    const sequence = ++requestSequence.current;
    if (value.length < 2) {
      setResults([]);
      setActiveIndex(-1);
      setMessage(value.length === 1 ? "Enter at least two characters." : "");
      setState("idle");
      return undefined;
    }

    const controller = new AbortController();
    setState("loading");
    setMessage("");
    const timer = window.setTimeout(() => {
      void searchLocations(value, { signal: controller.signal, limit: 5 })
        .then((nextResults) => {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          setResults(nextResults);
          setActiveIndex(nextResults.length ? 0 : -1);
          setState(nextResults.length ? "ready" : "empty");
          setMessage(nextResults.length ? "" : "No matching location found.");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error) || sequence !== requestSequence.current) return;
          setResults([]);
          setActiveIndex(-1);
          setState("error");
          setMessage(error instanceof Error ? error.message : "Location search is unavailable.");
        });
    }, Math.max(debounceMs, 250));

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [debounceMs, query]);

  function selectLocation(result: LocationSearchResult) {
    onSelect({ name: result.name, bbox: result.bbox, source: "map" });
    suppressSearchForQuery.current = result.label;
    setQuery(result.label);
    setResults([]);
    setActiveIndex(-1);
    setMessage("Location selected. The map is moving to this area.");
    setState("idle");
  }

  function clearSearch() {
    requestSequence.current += 1;
    suppressSearchForQuery.current = null;
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setMessage("");
    setState("idle");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (!results.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectLocation(results[activeIndex]);
    }
  }

  const hasResults = state === "ready" && results.length > 0;
  const activeOptionId = hasResults && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div className={`location-search ${className}`.trim()}>
      <label className="location-search__label" htmlFor={`${listboxId}-input`}>{label}</label>
      <div className="location-search__input-wrap">
        <Search aria-hidden="true" size={16} />
        <input
          id={`${listboxId}-input`}
          className="location-search__input"
          type="search"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={hasResults}
          aria-activedescendant={activeOptionId}
          aria-describedby={message ? `${listboxId}-status` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {state === "loading" ? <LoaderCircle className="location-search__spinner spin" aria-label="Searching locations" size={16} /> : null}
        {query ? (
          <button className="location-search__clear" type="button" onClick={clearSearch} aria-label="Clear location search" disabled={disabled}>
            <X size={15} />
          </button>
        ) : null}
      </div>

      {hasResults ? (
        <ul id={listboxId} className="location-search__results" role="listbox" aria-label="Location results">
          {results.map((result, index) => (
            <li key={result.id} id={`${listboxId}-option-${index}`} role="option" aria-selected={index === activeIndex}>
              <button
                className={`location-search__result ${index === activeIndex ? "is-active" : ""}`}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectLocation(result)}
              >
                <MapPin aria-hidden="true" size={15} />
                <span>
                  <strong>{result.name}</strong>
                  <small>{result.category ?? "Mapped place"}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p id={`${listboxId}-status`} className="location-search__status" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { ScrapePayload } from "./types";
import { OwnersView } from "./components/OwnersView";
import { allTargetsCached, useEnrichments } from "./hooks/useEnrichments";

interface RequestScrapeResponse {
  ok: boolean;
  payload?: ScrapePayload;
  error?: string;
  url?: string;
}

interface PanelUpdate {
  type: "REONOMY_PANEL_UPDATE";
  payload: ScrapePayload;
}

export default function App() {
  const [payload, setPayload] = useState<ScrapePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Gate the people-search lookups behind an explicit user click. Auto-running
  // on every property page burns captcha quota and blasts the IP rate-limit
  // window for properties the user is just glancing at. Resets to false on
  // every property-URL change so each property requires its own opt-in.
  const [enriching, setEnriching] = useState(false);
  // True when this property's lookups were all already cached and we
  // auto-enabled enrichment without prompting. Drives the green "Contacts
  // loaded from cache" badge in place of the button.
  const [autoLoaded, setAutoLoaded] = useState(false);
  const enrichments = useEnrichments(payload, enriching);

  useEffect(() => {
    setEnriching(false);
    setAutoLoaded(false);
    if (!payload) return;
    let cancelled = false;
    (async () => {
      const cached = await allTargetsCached(payload);
      if (cancelled) return;
      if (cached) {
        setEnriching(true);
        setAutoLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload?.url]);

  // Pull initial scrape on mount.
  useEffect(() => {
    (async () => {
      try {
        const resp: RequestScrapeResponse = await chrome.runtime.sendMessage({
          type: "REONOMY_REQUEST_SCRAPE",
        });
        if (resp?.ok && resp.payload && !resp.payload.error) {
          setPayload(resp.payload);
          setError(null);
        } else if (resp?.error) {
          setError(resp.error);
        }
      } catch (err) {
        setError(String(err));
      }
    })();
  }, []);

  // Subscribe to push updates from the background.
  useEffect(() => {
    const listener = (msg: PanelUpdate) => {
      if (msg?.type === "REONOMY_PANEL_UPDATE" && msg.payload) {
        setPayload(msg.payload);
        setError(null);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center px-3 py-2 border-b border-neutral-200 dark:border-neutral-700 sticky top-0 bg-white dark:bg-neutral-900 z-10">
        <strong className="text-sm">Reonomy</strong>
        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
          Property info
        </span>
      </header>

      {error && (
        <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900">
          {error}
        </div>
      )}

      <main className="flex-1 overflow-auto p-3">
        {payload && !enriching && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
            <span className="text-xs text-neutral-700 dark:text-neutral-300">
              Look up phones, emails, and relatives for this property?
            </span>
            <Button onClick={() => setEnriching(true)}>Find contacts</Button>
          </div>
        )}
        {payload && enriching && autoLoaded && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
            <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Contacts found
          </div>
        )}
        <OwnersView payload={payload} enrichments={enrichments} />
      </main>
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-neutral-300 disabled:hover:text-neutral-400 bg-transparent"
    >
      {children}
    </button>
  );
}


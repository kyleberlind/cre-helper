import { useEffect, useState } from "react";
import type { ScrapePayload } from "./types";
import { OwnersView } from "./components/OwnersView";
import { useEnrichments } from "./hooks/useEnrichments";

type Tab = "owners" | "raw";

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
  const [tab, setTab] = useState<Tab>("owners");
  const [error, setError] = useState<string | null>(null);
  const enrichments = useEnrichments(payload);

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

  const refresh = async () => {
    try {
      const resp: RequestScrapeResponse = await chrome.runtime.sendMessage({
        type: "REONOMY_REQUEST_SCRAPE",
      });
      if (resp?.ok && resp.payload && !resp.payload.error) {
        setPayload(resp.payload);
        setError(null);
      } else {
        setError(resp?.error || "Could not scrape this tab.");
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const copyJson = async () => {
    if (!payload) {
      setError("Nothing to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setError(null);
    } catch (err) {
      setError("Clipboard failed: " + err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-700 sticky top-0 bg-white dark:bg-neutral-900 z-10">
        <div>
          <strong className="text-sm">Reonomy</strong>
          <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
            Property info
          </span>
        </div>
        <div className="flex gap-1">
          <Button onClick={refresh}>Refresh</Button>
          <Button onClick={copyJson} disabled={!payload}>
            Copy JSON
          </Button>
        </div>
      </header>

      {error && (
        <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900">
          {error}
        </div>
      )}

      <nav className="flex border-b border-neutral-200 dark:border-neutral-700 px-2 pt-2">
        <TabButton active={tab === "owners"} onClick={() => setTab("owners")}>
          Owners
        </TabButton>
        <TabButton active={tab === "raw"} onClick={() => setTab("raw")}>
          Raw
        </TabButton>
      </nav>

      <main className="flex-1 overflow-auto p-3">
        {tab === "owners" && (
          <OwnersView payload={payload} enrichments={enrichments} />
        )}
        {tab === "raw" && (
          <pre className="text-[11px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded p-2 whitespace-pre-wrap break-words">
            {payload ? JSON.stringify(payload, null, 2) : "No data yet."}
          </pre>
        )}
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1.5 text-xs border-b-2 -mb-px " +
        (active
          ? "text-neutral-900 dark:text-neutral-100 border-accent"
          : "text-neutral-500 dark:text-neutral-400 border-transparent hover:text-neutral-700 dark:hover:text-neutral-200")
      }
    >
      {children}
    </button>
  );
}

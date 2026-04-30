// Open the side panel when the toolbar icon is clicked. MV3 service workers
// get terminated and restarted, so re-register on every wake-up path: top
// level (cold start), onInstalled (fresh install / update), and onStartup
// (browser launch with a previously-installed extension).
function enablePanelOnActionClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed", err));
}
enablePanelOnActionClick();
chrome.runtime.onInstalled.addListener(enablePanelOnActionClick);
chrome.runtime.onStartup.addListener(enablePanelOnActionClick);

// People-search "hidden tab" fetch. The side panel sends us a URL; we open
// it, give the page time to finish loading + run any post-load JS, grab the
// rendered HTML via scripting, and close the tab.
//
// We briefly foreground the new tab and then immediately restore focus to
// the user's original tab. The reason: Chrome aggressively throttles JS
// (setTimeout/setInterval clamped to ~1 callback/min) in tabs that have
// never been foregrounded, which prevents TPS/FTN's invisible-hCaptcha
// auto-submit from completing — we land on the captcha interstitial. Tabs
// that were even momentarily foregrounded get a grace period of un-throttled
// execution, long enough for the captcha to silently resolve. The visible
// cost is a brief flicker as the user's active tab changes and snaps back.
//
// After the initial navigation completes we poll the document for result
// markup, exiting as soon as it shows up. This collapses the typical-case
// post-load wait from a fixed ~4.5s (sleep + secondComplete) down to one
// poll interval, while still giving captcha-walled pages a generous
// ceiling for the auto-submit + secondary navigation to land.
const HIDDEN_TAB_LOAD_TIMEOUT_MS = 10000;
const HIDDEN_TAB_CONTENT_POLL_INTERVAL_MS = 150;
const HIDDEN_TAB_CONTENT_POLL_BUDGET_MS = 6000;

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll the tab's document for the first sign of real result markup from
// either TPS or FTN. Returns once any sentinel is present, or after the
// budget elapses. executeScript can transiently throw while the tab is
// navigating (e.g. mid-captcha-auto-submit) — we swallow and retry so the
// loop spans those gaps.
async function pollForResultContent(tabId, budgetMs, intervalMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Sentinels across the four pages we fetch:
          //  • TPS search / reverse-address: .card-summary / [data-detail-link]
          //  • TPS detail: .content-label
          //  • FTN search / reverse-address: a.detail-link[href*="/search/people/results"]
          //  • FTN detail: a.linked-record
          return (
            !!document.querySelector(".card-summary") ||
            !!document.querySelector("[data-detail-link]") ||
            !!document.querySelector(".content-label") ||
            !!document.querySelector(
              'a.detail-link[href*="/search/people/results"]'
            ) ||
            !!document.querySelector("a.linked-record")
          );
        },
      });
      if (res?.[0]?.result === true) return "ready";
    } catch {
      // Tab navigating or briefly inaccessible — keep polling.
    }
    await sleep(intervalMs);
  }
  return "timeout";
}

async function handlePeopleSearchFetch(url) {
  // Remember the user's currently-active tab so we can hand focus back
  // immediately after creating the people-search tab. See the file-level
  // comment for why the brief foreground is necessary.
  let originalTabId;
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    originalTabId = activeTab?.id;
  } catch {
    /* no active tab — proceed without focus restore */
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (err) {
    return { status: "error", error: String(err?.message || err) };
  }
  const tabId = tab.id;
  if (!tabId) return { status: "error", error: "no tab id" };

  // Snap focus back to whatever the user was looking at. The new tab keeps
  // an un-throttled JS event loop because Chrome flags it as having been
  // foregrounded; the snap-back means the user only sees a brief flicker.
  if (originalTabId && originalTabId !== tabId) {
    try {
      await chrome.tabs.update(originalTabId, { active: true });
    } catch {
      /* original tab may be gone — fine, the people-search tab will close shortly */
    }
  }

  let html = "";
  try {
    await waitForTabComplete(tabId, HIDDEN_TAB_LOAD_TIMEOUT_MS);
    // Replaces the previous fixed sleep + secondComplete wait. On captcha-
    // walled pages this still spans the auto-submit + secondary navigation
    // (executeScript transiently fails during the nav, the loop retries);
    // on uncaptcha'd pages we exit on the first poll.
    await pollForResultContent(
      tabId,
      HIDDEN_TAB_CONTENT_POLL_BUDGET_MS,
      HIDDEN_TAB_CONTENT_POLL_INTERVAL_MS
    );

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    html = results?.[0]?.result || "";
  } catch (err) {
    console.error("[bg] hidden-tab fetch failed", err);
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* tab already gone */
    }
  }

  if (!html) return { status: "error" };
  return { status: "ok", html };
}

// Relay scrape results from content scripts to the side panel (if open).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PEOPLE_SEARCH_FETCH" && typeof msg.url === "string") {
    handlePeopleSearchFetch(msg.url)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ status: "error", error: String(err?.message || err) })
      );
    return true; // async sendResponse
  }
  if (msg?.type === "REONOMY_SCRAPE_RESULT") {
    // Forward to the side panel. If it isn't open, sendMessage rejects with
    // "Could not establish connection. Receiving end does not exist." — swallow
    // it since a closed panel is a normal state, not an error.
    const p = chrome.runtime.sendMessage({
      type: "REONOMY_PANEL_UPDATE",
      payload: msg.payload,
      tabId: sender.tab?.id,
      url: sender.tab?.url,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  }
  // Side panel requests a fresh scrape of the active tab.
  if (msg?.type === "REONOMY_REQUEST_SCRAPE") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      if (!/^https:\/\/app\.reonomy\.com\/.*\/property\//.test(tab.url || "")) {
        sendResponse({
          ok: false,
          error: "Active tab is not a Reonomy property page",
          url: tab.url,
        });
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "REONOMY_SCRAPE_NOW" },
        (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              ok: false,
              error: chrome.runtime.lastError.message,
            });
            return;
          }
          sendResponse({ ok: true, payload: resp, url: tab.url });
        }
      );
    });
    return true; // async sendResponse
  }
});

const PROPERTY_RE = /^https:\/\/app\.reonomy\.com\/.*\/property\//;

// Remember which tabs we've already auto-opened on so we don't re-open after
// the user deliberately closes the panel.
const autoOpenedTabs = new Set();

async function maybeOpenSidePanel(tabId) {
  try {
    // Don't call setOptions({ tabId, ... }) here — that switches the panel
    // into per-tab mode for this tab, and per-tab mode breaks the global
    // openPanelOnActionClick behavior, leaving the icon click dead on
    // Reonomy property tabs. We just attempt open(), which may fail without
    // a user gesture in modern Chrome — that's fine, the icon click still
    // works because we never poisoned the per-tab state.
    await chrome.sidePanel.open({ tabId });
    autoOpenedTabs.add(tabId);
  } catch (err) {
    console.debug("[Reonomy] sidePanel.open failed:", err?.message || err);
  }
}

// Push fresh scrape data to the side panel for a tab. Used both on full page
// loads and on SPA URL changes.
function requestScrapeAndPush(tabId, url) {
  // SPA route changes need a beat for React to render the new section.
  setTimeout(() => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "REONOMY_SCRAPE_NOW" },
      (payload) => {
        if (chrome.runtime.lastError || !payload || payload.error) return;
        const p = chrome.runtime.sendMessage({
          type: "REONOMY_PANEL_UPDATE",
          payload,
          tabId,
          url,
        });
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    );
  }, 400);
}

// Track the last URL we scraped for each tab so we don't double-fire when
// onUpdated emits multiple events for the same SPA navigation.
const lastScrapedUrlByTab = new Map();

// When the user navigates within a Reonomy tab, refresh the panel AND auto-
// open it on property pages. This fires on full loads (changeInfo.status ===
// "complete") and on SPA history changes (changeInfo.url is set).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab.url || "";
  const isProperty = PROPERTY_RE.test(url);

  const isFullLoad = changeInfo.status === "complete";
  const isUrlChange = !!changeInfo.url;

  if (isProperty && (isFullLoad || isUrlChange)) {
    if (lastScrapedUrlByTab.get(tabId) !== url || isFullLoad) {
      lastScrapedUrlByTab.set(tabId, url);
      requestScrapeAndPush(tabId, url);
    }
  }

  if (isProperty && !autoOpenedTabs.has(tabId)) {
    maybeOpenSidePanel(tabId);
  }

  if (!isProperty && autoOpenedTabs.has(tabId)) {
    autoOpenedTabs.delete(tabId);
  }
});

// Reonomy is a SPA, so most navigation is pushState rather than a real
// document load. tabs.onUpdated with changeInfo.url is supposed to fire for
// pushState too, but in practice it occasionally misses calls. Layer in
// webNavigation.onHistoryStateUpdated — it's the canonical SPA-aware
// listener — so the panel always re-syncs when the URL changes inside a
// Reonomy tab.
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    ({ tabId, frameId, url }) => {
      if (frameId !== 0) return; // ignore subframes
      if (!PROPERTY_RE.test(url)) return;
      if (lastScrapedUrlByTab.get(tabId) === url) return;
      lastScrapedUrlByTab.set(tabId, url);
      requestScrapeAndPush(tabId, url);
      if (!autoOpenedTabs.has(tabId)) maybeOpenSidePanel(tabId);
    },
    { url: [{ hostEquals: "app.reonomy.com" }] }
  );
}

// Handle tab activation: switching to an already-loaded property tab should
// also refresh the panel since the user expects it to track the active tab.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (!PROPERTY_RE.test(url)) return;
    if (!autoOpenedTabs.has(tabId)) maybeOpenSidePanel(tabId);
    requestScrapeAndPush(tabId, url);
  } catch {
    /* tab gone */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  autoOpenedTabs.delete(tabId);
  lastScrapedUrlByTab.delete(tabId);
});

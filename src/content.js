// Content script: scrapes the current Reonomy page and reports structured data.
// Reonomy's DOM is not a stable public contract, so we rely on generic signals
// (meta tags, JSON-LD, headings, dl/dt/dd, tables, labeled rows) and surface
// whatever we find. The side panel renders whatever we send.

(function () {
  "use strict";

  const clean = (s) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim());

  function getMeta() {
    const meta = {};
    document.querySelectorAll("meta").forEach((m) => {
      const k = m.getAttribute("property") || m.getAttribute("name");
      const v = m.getAttribute("content");
      if (k && v) meta[k] = clean(v);
    });
    return meta;
  }

  function getJsonLd() {
    const blocks = [];
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent || "null");
          if (parsed) blocks.push(parsed);
        } catch {
          /* ignore bad JSON-LD */
        }
      });
    return blocks;
  }

  function getHeadings() {
    return {
      title: clean(document.title),
      h1: Array.from(document.querySelectorAll("h1"))
        .map((e) => clean(e.innerText))
        .filter(Boolean),
      h2: Array.from(document.querySelectorAll("h2"))
        .map((e) => clean(e.innerText))
        .filter(Boolean)
        .slice(0, 40),
    };
  }

  // Pull definition lists — a common structure for property attributes.
  function getDefinitionLists() {
    const out = [];
    document.querySelectorAll("dl").forEach((dl) => {
      const pairs = [];
      const dts = Array.from(dl.querySelectorAll(":scope > dt"));
      dts.forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") {
          const k = clean(dt.innerText);
          const v = clean(dd.innerText);
          if (k || v) pairs.push({ label: k, value: v });
        }
      });
      if (pairs.length) out.push(pairs);
    });
    return out;
  }

  // Pull two-column tables as key/value pairs.
  function getTables() {
    const out = [];
    document.querySelectorAll("table").forEach((tbl) => {
      const rows = Array.from(tbl.querySelectorAll("tr"));
      const kv = [];
      const matrix = [];
      rows.forEach((tr) => {
        const cells = Array.from(tr.children).map((c) => clean(c.innerText));
        if (cells.length === 2) kv.push({ label: cells[0], value: cells[1] });
        matrix.push(cells);
      });
      out.push({ kv, matrix });
    });
    return out;
  }

  // Heuristic label/value scraper: for each short text node (< 40 chars, no period),
  // check whether a nearby sibling or child contains the value. This catches the
  // typical "Label \n Value" card layout used on listing pages.
  function getLabeledPairs() {
    const results = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      "main *, [role='main'] *, body *"
    );
    let scanned = 0;
    for (const el of candidates) {
      if (scanned++ > 4000) break; // safety cap
      if (!el || !el.childNodes || el.children.length > 6) continue;
      const text = clean(el.innerText || "");
      if (!text || text.length > 2000) continue;

      // label-like: short, ends without punctuation, Title-Case or ALL CAPS-ish
      const isLabelLike =
        text.length > 1 &&
        text.length < 60 &&
        !/[.!?]$/.test(text) &&
        /[A-Za-z]/.test(text);
      if (!isLabelLike) continue;

      // find a sibling with the value
      let valueEl = el.nextElementSibling;
      let value = valueEl ? clean(valueEl.innerText || "") : "";

      // or a single child with the value if the container wraps both
      if (!value && el.children.length === 2) {
        const [a, b] = el.children;
        const aText = clean(a.innerText || "");
        const bText = clean(b.innerText || "");
        if (aText && bText && aText !== bText) {
          const key = aText + "::" + bText;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ label: aText, value: bText });
          }
          continue;
        }
      }

      if (value && value !== text && value.length < 500) {
        const key = text + "::" + value;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ label: text, value });
        }
      }
    }
    // de-duplicate trivially repeated rows
    return results.slice(0, 400);
  }

  // Try to identify the primary address/title for the listing.
  function guessHeadline(meta, headings) {
    return (
      meta["og:title"] ||
      meta["twitter:title"] ||
      headings.h1[0] ||
      headings.title ||
      ""
    );
  }

  const PHONE_TYPE_RE =
    /(Residential|Mobile|Business|Work|Home|Landline|Unknown|Other)/i;
  const EMAIL_RE_G = /\S+@\S+\.[A-Za-z]{2,}/g;

  // Reonomy's /ownership view exposes stable data-testid hooks. Walk the
  // owner-card and contact-item DOM directly when it's available so we can
  // capture per-phone entity labels, parent company ("Via X"), and titles
  // that the heuristic text parser drops on the floor.
  function absoluteHref(href) {
    if (!href) return undefined;
    try {
      return new URL(href, location.origin).href;
    } catch {
      return undefined;
    }
  }

  function parseContactBlock(root) {
    const phones = [];
    root.querySelectorAll('[data-testid="people-contact-phone-id"]').forEach((el) => {
      const number = clean(el.textContent);
      if (!number) return;
      const ps = Array.from(el.parentElement?.querySelectorAll(":scope > p") || []);
      const idx = ps.indexOf(el);
      const entity = idx >= 0 ? clean(ps[idx + 1]?.innerText || "") : "";
      const type = idx >= 0 ? clean(ps[idx + 2]?.innerText || "") : "";
      const phone = { number, type };
      if (entity) phone.entity = entity;
      phones.push(phone);
    });

    const emails = [];
    root.querySelectorAll('[data-testid="people-contact-email-id"]').forEach((el) => {
      const e = clean(el.textContent);
      if (e && !emails.includes(e)) emails.push(e);
    });

    const addresses = [];
    root.querySelectorAll('[data-testid="people-contact-address-id"]').forEach((el) => {
      const a = clean(el.textContent);
      if (a && !addresses.includes(a)) addresses.push(a);
    });

    return { phones, emails, addresses };
  }

  function getOwnersFromDom() {
    const cards = document.querySelectorAll('[data-testid="owner-card-id"]');
    if (!cards.length) return null;

    const owners = [];
    cards.forEach((card) => {
      const link = card.querySelector(
        'a[href*="/!/company/"], a[href*="/!/person/"]'
      );
      if (!link) return;
      const href = link.getAttribute("href") || "";
      const kind = href.includes("/!/company/") ? "company" : "person";
      const name = clean(link.getAttribute("title") || link.textContent);
      if (!name) return;

      // The header row holds: name (in a <p> with the link), an optional
      // "Via <parent>" line, and an optional title line. They sit as direct
      // <p> children of the same container as the name's <p>.
      let parentCompany = "";
      let title = "";
      const namePara = link.closest("p");
      const headerBox = namePara?.parentElement;
      if (headerBox) {
        const ps = Array.from(headerBox.querySelectorAll(":scope > p"));
        ps.forEach((p) => {
          if (p === namePara) return;
          const t = clean(p.innerText);
          if (!t) return;
          if (/^Via\s+/i.test(t)) parentCompany = t.replace(/^Via\s+/i, "").trim();
          else title = title ? `${title} · ${t}` : t;
        });
      }

      const { phones, emails, addresses } = parseContactBlock(card);

      const owner = {
        name,
        kind,
        phones,
        emails,
        addresses,
      };
      if (parentCompany) owner.parentCompany = parentCompany;
      if (title) owner.title = title;
      const url = absoluteHref(href);
      if (url) owner.profileUrl = url;
      owners.push(owner);
    });

    return owners;
  }

  function getReportedFromDom() {
    const root = document.querySelector('[data-testid="reported-owner-items"]');
    if (!root) return null;
    const names = [];
    // Names always sit in a <p> that contains a "Copy name" button.
    root.querySelectorAll('p button[title="Copy name"]').forEach((btn) => {
      const p = btn.closest("p");
      if (!p) return;
      const clone = p.cloneNode(true);
      clone.querySelectorAll("button").forEach((b) => b.remove());
      const n = clean(clone.textContent);
      if (n && !names.includes(n)) names.push(n);
    });
    const addrEl = root.querySelector('[data-testid="people-contact-address-id"]');
    const address = clean(addrEl?.textContent || "");
    if (!names.length && !address) return null;
    return { names, address };
  }

  function getContactsFromDom() {
    const items = document.querySelectorAll('[data-testid="contact-item"]');
    if (!items.length) return [];
    const contacts = [];
    items.forEach((item) => {
      const link = item.querySelector('a[data-testid="contact-person-link"]');
      const href = link?.getAttribute("href") || "";
      const ps = item.querySelectorAll("p");
      const name = clean(ps[0]?.innerText || link?.textContent || "");
      if (!name) return;
      const title = clean(ps[1]?.innerText || "");
      const role = clean(ps[2]?.innerText || "");

      // Phones/emails/addresses live in a sibling block within the same
      // contact wrapper (jss653 / jss555). Scope by the closest container so
      // we don't bleed data from neighboring contacts.
      const wrapper = item.closest('[data-testid="contact-item"]')?.parentElement;
      const { phones, emails, addresses } = parseContactBlock(wrapper || item);

      const contact = { name, phones, emails, addresses };
      if (title) contact.title = title;
      if (role) contact.role = role;
      const url = absoluteHref(href);
      if (url) contact.profileUrl = url;
      contacts.push(contact);
    });
    return contacts;
  }

  // Parse owner blocks out of the heuristic labeledPairs list. Each owner row
  // comes through as {label: "<Name> Show Portfolio Preview", value: "Phone
  // Numbers ... Emails ... Addresses ..."}, which is reliably produced by the
  // generic label/value DOM walker even when innerText doesn't break cleanly.
  function getOwnersFromLabeledPairs(labeledPairs) {
    const owners = [];
    const seenNames = new Set();
    const ownerTag = /\s*Show Portfolio Preview\s*$/;

    for (const { label, value } of labeledPairs || []) {
      if (!ownerTag.test(label)) continue;
      const name = label.replace(ownerTag, "").trim();
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);

      const v = String(value || "");
      const phonesM = v.match(
        /Phone Numbers\s+(.+?)(?=\s+Emails\b|\s+Addresses\b|$)/
      );
      const emailsM = v.match(/Emails\s+(.+?)(?=\s+Addresses\b|$)/);
      const addressesM = v.match(/Addresses\s+(.+?)$/);

      const phones = [];
      if (phonesM) {
        const phoneStr = phonesM[1];
        const pairRe = new RegExp(
          "(\\+?[\\d][\\d\\-().\\s]{6,}?)\\s+(" +
            PHONE_TYPE_RE.source.replace(/[()]/g, "") +
            ")\\b",
          "gi"
        );
        let m;
        while ((m = pairRe.exec(phoneStr)) !== null) {
          phones.push({ number: m[1].trim(), type: m[2] });
        }
        // Fallback: any loose phone numbers without a type
        if (!phones.length) {
          const loose = phoneStr.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
          loose.forEach((n) => phones.push({ number: n, type: "" }));
        }
      }

      const emails = emailsM ? emailsM[1].match(EMAIL_RE_G) || [] : [];

      const addresses = [];
      if (addressesM) {
        const addrStr = addressesM[1].trim();
        // Match full US addresses: "<street>, <city>, <STATE> <ZIP>". Fall back
        // to the whole string if the pattern doesn't fit.
        const full = addrStr.match(
          /[^,]+,\s*[^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/g
        );
        if (full && full.length) addresses.push(...full.map((s) => s.trim()));
        else if (addrStr) addresses.push(addrStr);
      }

      owners.push({ name, phones, emails, addresses });
    }

    const reportedPair = (labeledPairs || []).find(
      ({ label }) => label === "Reported Owner"
    );
    let reported = null;
    if (reportedPair) {
      const v = String(reportedPair.value || "");
      // Address must begin with a street number so we don't swallow preceding
      // names (the previous lazy `.*?` was matching from position 0).
      const addrMatch = v.match(
        /\d+\s+[A-Za-z][^,]*,\s*[^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/
      );
      let address = "";
      let namesPart = v;
      if (addrMatch) {
        address = addrMatch[0].trim();
        namesPart = v.replace(addrMatch[0], "").trim();
      }
      // Split the names blob. First try to match any already-known owner names
      // we parsed above — that gives the cleanest split. Anything left over
      // gets kept as a single extra entry.
      const ownerNames = owners.map((o) => o.name);
      const foundNames = [];
      let remaining = namesPart;
      ownerNames
        .slice()
        .sort((a, b) => b.length - a.length)
        .forEach((n) => {
          const idx = remaining.indexOf(n);
          if (idx !== -1) {
            foundNames.push(n);
            remaining = (
              remaining.slice(0, idx) + " " + remaining.slice(idx + n.length)
            )
              .replace(/\s+/g, " ")
              .trim();
          }
        });
      // Also match any plain 2–3-word capitalized tokens that remain.
      const leftover =
        remaining.match(/[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,2}/g) ||
        [];
      leftover.forEach((n) => {
        if (!foundNames.includes(n)) foundNames.push(n);
      });
      reported = {
        names: foundNames.length ? foundNames : namesPart ? [namesPart] : [],
        address,
      };
    }

    return { owners, reported };
  }

  // Parse the Owners section on /ownership. Tries the line-based parser first
  // (clean when the DOM produces a line per field) and falls back to the
  // labeledPairs-based parser (more tolerant of messy innerText).
  function getOwnersFromText(labeledPairs) {
    const root = document.querySelector("main, [role='main']") || document.body;
    const text = root.innerText || "";
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Accept "Owners", "Owners (2)", or a line that BEGINS with Owners followed
    // by punctuation. This is the header of the section.
    const start = lines.findIndex((l) => /^Owners(\s*\(\d+\))?$/i.test(l));
    if (start === -1) {
      const fromPairs = getOwnersFromLabeledPairs(labeledPairs);
      return {
        ...fromPairs,
        rawText: lines.slice(0, 80).join("\n"),
        source: "labeledPairs",
      };
    }

    const endMarkers = new Set([
      "Sales",
      "Debt",
      "Tax",
      "Demographics",
      "Notes",
      "Building & Lot",
      "Occupants",
    ]);

    const owners = [];
    let current = null;
    let mode = null; // phones | emails | addresses
    let reported = null;
    let inReported = false;
    const rawBlock = [];

    const commitCurrent = () => {
      if (current) owners.push(current);
      current = null;
      mode = null;
    };

    const looksLikeAddress = (s) =>
      /,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(s) ||
      /\d+\s+[A-Za-z].*,/.test(s);

    const phoneTypes =
      /^(Residential|Mobile|Business|Work|Home|Landline|Unknown|Other)$/i;

    for (let j = start + 1; j < lines.length; j++) {
      const line = lines[j];
      if (endMarkers.has(line)) break;
      rawBlock.push(line);

      if (line === "Reported Owner") {
        commitCurrent();
        inReported = true;
        reported = { names: [], address: "" };
        continue;
      }

      if (inReported) {
        if (looksLikeAddress(line)) reported.address = line;
        else if (!/^Show Portfolio/i.test(line)) reported.names.push(line);
        continue;
      }

      // Start of a new owner block.
      const showIdx = line.indexOf("Show Portfolio Preview");
      if (showIdx >= 0) {
        commitCurrent();
        const name = line.slice(0, showIdx).trim();
        current = { name, phones: [], emails: [], addresses: [] };
        mode = null;
        continue;
      }
      if (lines[j + 1] === "Show Portfolio Preview" && !current) {
        commitCurrent();
        current = { name: line, phones: [], emails: [], addresses: [] };
        mode = null;
        j++; // skip the "Show Portfolio Preview" line
        continue;
      }
      if (line === "Show Portfolio Preview") continue;

      if (line === "Phone Numbers") { mode = "phones"; continue; }
      if (line === "Emails") { mode = "emails"; continue; }
      if (line === "Addresses") { mode = "addresses"; continue; }

      if (!current) continue;

      if (mode === "phones") {
        const m = line.match(
          /^(\+?[\d][\d\-().\s]{6,})\s+(Residential|Mobile|Business|Work|Home|Landline|Unknown|Other)\s*$/i
        );
        if (m) {
          current.phones.push({ number: m[1].trim(), type: m[2] });
        } else if (phoneTypes.test(line) && current.phones.length) {
          current.phones[current.phones.length - 1].type = line;
        } else if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) {
          current.phones.push({ number: line, type: "" });
        }
      } else if (mode === "emails") {
        if (/@/.test(line)) current.emails.push(line);
      } else if (mode === "addresses") {
        if (line) current.addresses.push(line);
      }
    }
    commitCurrent();

    // If the line scan found the "Owners" header but no actual owners, fall
    // back to the labeledPairs parser which uses DOM structure instead.
    if (!owners.length && !reported) {
      const fromPairs = getOwnersFromLabeledPairs(labeledPairs);
      if (fromPairs.owners.length || fromPairs.reported) {
        return { ...fromPairs, rawText: rawBlock.join("\n"), source: "labeledPairs-fallback" };
      }
    }

    return {
      owners,
      reported,
      rawText: rawBlock.join("\n"),
      source: "text",
    };
  }

  // Parse the Reonomy property URL: /!/property/<uuid>/<section>
  function parsePropertyUrl() {
    const m = location.pathname.match(
      /\/property\/([0-9a-f-]{8,})(?:\/([^/?#]+))?/i
    );
    if (!m) return null;
    return { propertyId: m[1], section: m[2] || "" };
  }

  function getOwnership(labeledPairs) {
    const domOwners = getOwnersFromDom();
    if (domOwners && domOwners.length) {
      return {
        owners: domOwners,
        reported: getReportedFromDom(),
        contacts: getContactsFromDom(),
        source: "dom",
      };
    }
    return getOwnersFromText(labeledPairs);
  }

  function scrape() {
    const meta = getMeta();
    const headings = getHeadings();
    const labeledPairs = getLabeledPairs();
    return {
      url: location.href,
      scrapedAt: new Date().toISOString(),
      property: parsePropertyUrl(),
      ownership: getOwnership(labeledPairs),
      headline: guessHeadline(meta, headings),
      description:
        meta["og:description"] || meta["description"] || meta["twitter:description"] || "",
      meta,
      jsonLd: getJsonLd(),
      headings,
      definitionLists: getDefinitionLists(),
      tables: getTables(),
      labeledPairs,
    };
  }

  // Build the scrape payload, write good ownership to cache, or pull ownership
  // from cache when the current sub-tab doesn't have it.
  async function computePayload() {
    const payload = scrape();
    const propId = payload.property?.propertyId;
    if (!propId) return payload;

    const key = "reonomy_owners_" + propId;
    try {
      const liveOwners = payload.ownership?.owners?.length || 0;
      const hasReported = !!payload.ownership?.reported;

      if (liveOwners > 0 || hasReported) {
        // Cache the fresh data for this property.
        await chrome.storage.local.set({
          [key]: {
            ownership: {
              owners: payload.ownership.owners,
              reported: payload.ownership.reported,
              contacts: payload.ownership.contacts,
              source: payload.ownership.source,
            },
            scrapedAt: payload.scrapedAt,
            url: payload.url,
          },
        });
      } else {
        // No live owners on this sub-tab — restore from cache if we've seen
        // the /ownership page for this property before.
        const got = await chrome.storage.local.get(key);
        const cached = got[key];
        if (cached?.ownership?.owners?.length || cached?.ownership?.reported) {
          payload.ownership = {
            ...cached.ownership,
            source: "cached",
            cachedAt: cached.scrapedAt,
            cachedUrl: cached.url,
            rawText: "",
          };
        }
      }
    } catch (err) {
      console.debug("[Reonomy] cache access failed", err);
    }
    return payload;
  }

  async function sendScrape() {
    let payload;
    try {
      payload = await computePayload();
    } catch (err) {
      console.error("[Reonomy Side Panel] scrape failed", err);
      return;
    }
    try {
      const p = chrome.runtime.sendMessage({
        type: "REONOMY_SCRAPE_RESULT",
        payload,
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* extension context invalidated */
    }
  }

  // Respond to explicit requests from the side panel / background.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "REONOMY_SCRAPE_NOW") {
      computePayload()
        .then((payload) => sendResponse(payload))
        .catch((err) => sendResponse({ error: String(err) }));
      return true; // async sendResponse
    }
  });

  // Initial scrape once the page settles.
  const initial = () => setTimeout(sendScrape, 600);
  if (document.readyState === "complete") initial();
  else window.addEventListener("load", initial, { once: true });

  // Reonomy is a SPA, so also watch for URL / DOM changes.
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(sendScrape, 900);
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Debounced rescrape on significant DOM mutations.
  let debounce;
  const contentObserver = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(sendScrape, 1500);
  });
  contentObserver.observe(document.body, { childList: true, subtree: true });
})();

import type {
  EnrichmentMatch,
  EnrichmentResult,
  EnrichmentSource,
  EnrichmentStatus,
  PhoneMeta,
} from "../types";
import { getCached, keyFor, setCached } from "./peopleSearchCache";

export interface PersonInput {
  fullName: string;
  city?: string;
  state?: string;
  /** First Reonomy address line, optional, used to derive city/state if not given. */
  address?: string;
}

export function splitName(full: string): { first: string; last: string } {
  const parts = (full || "").trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

export function parseLocation(address: string): {
  city: string;
  state: string;
} {
  const parts = (address || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return { city: "", state: "" };
  const stateZip = parts[parts.length - 1];
  const stateMatch = stateZip.match(/^([A-Z]{2})\b/);
  const state = stateMatch ? stateMatch[1] : "";
  const city = parts.length >= 3 ? parts[parts.length - 2] : "";
  return { city, state };
}

// TPS surfaces "Greenfield, IN" *or* "Indianapolis IN" (no comma). parseLocation
// only handles the comma form, so accept either here.
function parseCityState(s: string): { city: string; state: string } | null {
  const t = s.trim().replace(/\.+$/, "").trim();
  if (!t) return null;
  const m1 = t.match(/^(.+?),\s*([A-Z]{2})$/);
  if (m1) return { city: m1[1].trim(), state: m1[2] };
  const m2 = t.match(/^(.+?)\s+([A-Z]{2})$/);
  if (m2) return { city: m2[1].trim(), state: m2[2] };
  return null;
}

// Is the Reonomy address backed up by what the TPS match knows? We compare
// the full street if the detail page gave us one; otherwise fall back to a
// city+state match against the search card's known cities.
export function addressMatchesEnrichment(
  address: string,
  match: EnrichmentMatch
): boolean {
  if (!address) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const target = norm(address);
  for (const a of match.addresses ?? []) {
    const candidate = norm(a);
    if (!candidate) continue;
    if (candidate === target) return true;
    // Detail-page addresses may include unit suffixes that the source omits
    // (or vice versa); match if one fully contains the other's leading
    // street + zip-anchor segment.
    if (candidate.length > 8 && target.includes(candidate)) return true;
    if (target.length > 8 && candidate.includes(target)) return true;
  }

  const { city, state } = parseLocation(address);
  if (!city || !state) return false;
  const cityNorm = city.toLowerCase();
  if (
    match.city &&
    match.state &&
    match.state === state &&
    match.city.toLowerCase() === cityNorm
  ) {
    return true;
  }
  for (const a of match.addresses ?? []) {
    const cs = parseCityState(a);
    if (cs && cs.state === state && cs.city.toLowerCase() === cityNorm) {
      return true;
    }
  }
  return false;
}

// Per-source corroboration helpers. They walk EnrichmentResult.bySource so
// the UI can label which adapter(s) confirmed a given value — e.g. a phone
// might be "via tps" today but "via tps + ftn" once both detail pages are
// parsed. Always returns sources in a stable order (tps before ftn) so the
// rendered label is consistent.
const SOURCE_ORDER: EnrichmentSource[] = ["truepeoplesearch", "familytreenow"];

function sourcesForPredicate(
  result: EnrichmentResult | undefined,
  predicate: (match: EnrichmentMatch) => boolean
): EnrichmentSource[] {
  if (!result?.bySource) return [];
  const out: EnrichmentSource[] = [];
  for (const src of SOURCE_ORDER) {
    const match = result.bySource[src];
    if (match && predicate(match)) out.push(src);
  }
  return out;
}

export function sourcesCorroboratingPhone(
  phone: string,
  result: EnrichmentResult | undefined
): EnrichmentSource[] {
  return sourcesForPredicate(result, (m) => phoneMatchesEnrichment(phone, m));
}

export function sourcesCorroboratingEmail(
  email: string,
  result: EnrichmentResult | undefined
): EnrichmentSource[] {
  return sourcesForPredicate(result, (m) => emailMatchesEnrichment(email, m));
}

export function sourcesCorroboratingAddress(
  address: string,
  result: EnrichmentResult | undefined
): EnrichmentSource[] {
  return sourcesForPredicate(result, (m) =>
    addressMatchesEnrichment(address, m)
  );
}

// Name match: compare the owner's first/last to the adapter's matched
// person's first/last, normalized to lowercase. Middle names/initials are
// ignored on both sides since they're surfaced inconsistently.
export function sourcesCorroboratingName(
  ownerName: string,
  result: EnrichmentResult | undefined
): EnrichmentSource[] {
  if (!ownerName) return [];
  const { first: oFirst, last: oLast } = splitName(ownerName);
  if (!oFirst || !oLast) return [];
  const ofL = oFirst.toLowerCase();
  const olL = oLast.toLowerCase();
  return sourcesForPredicate(result, (m) => {
    if (!m.name) return false;
    const { first: mFirst, last: mLast } = splitName(m.name);
    return (
      !!mFirst &&
      !!mLast &&
      mFirst.toLowerCase() === ofL &&
      mLast.toLowerCase() === olL
    );
  });
}

export function phoneMatchesEnrichment(
  phone: string,
  match: EnrichmentMatch
): boolean {
  const digits = normalizePhone(phone);
  if (!digits || !match.phones?.length) return false;
  // Compare last 10 digits to ignore +1 / leading-1 differences.
  const tail = digits.slice(-10);
  if (tail.length < 7) return false;
  return match.phones.some((p) => p.slice(-10) === tail);
}

export function emailMatchesEnrichment(
  email: string,
  match: EnrichmentMatch
): boolean {
  const v = (email || "").trim().toLowerCase();
  if (!v || !match.emails?.length) return false;
  return match.emails.includes(v);
}

export function contactLookupKey(input: PersonInput): string {
  const { first, last } = splitName(input.fullName);
  const { city, state } = resolveLocation(input);
  return keyFor(first, last, city, state);
}

function resolveLocation(input: PersonInput): { city: string; state: string } {
  if (input.city || input.state) {
    return { city: input.city || "", state: input.state || "" };
  }
  return parseLocation(input.address || "");
}

const BLOCK_MARKERS = [
  "Just a moment",
  "Checking your browser",
  "verify you are human",
  "Attention Required",
  "cf-browser-verification",
  // Both FamilyTreeNow and TruePeopleSearch front their result pages with an
  // hCaptcha auto-submit interstitial. The token is fetched + posted by JS,
  // which Chrome throttles in inactive tabs. When we land on the interstitial
  // we want this classified as `blocked`, not as a parse failure.
  "submitFormCaptcha",
  "captchaToken",
  "Loading content, please wait",
  // FTN serves a plain-HTML rate-limit page (no captcha) when an IP exceeds
  // its per-window quota. Counts as blocked, not no_match.
  "IP address has been temporarily rate-limited",
];

function looksBlocked(html: string): boolean {
  // Scan the whole document (lowercased once). The captcha-script markers
  // like `captchaToken` and "Loading content, please wait" live inside
  // inline <script>s that, on TPS's /resultaddress page, sit well past the
  // first few KB after a wall of CSS preload / gtag boilerplate. A short
  // head-only scan misses them and the captcha interstitial leaks through
  // to the parser as a phantom "no match".
  const lower = html.toLowerCase();
  return BLOCK_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

async function fetchHtml(
  url: string,
  signal?: AbortSignal
): Promise<{ status: "ok"; html: string } | { status: "blocked" | "error" }> {
  console.info("[peopleSearch] hidden-tab GET", url);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const result: { status: string; html?: string; error?: string } =
      await chrome.runtime.sendMessage({
        type: "PEOPLE_SEARCH_FETCH",
        url,
      });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!result || result.status !== "ok" || typeof result.html !== "string") {
      console.warn(
        `[peopleSearch] hidden-tab returned status=${result?.status}${result?.error ? " error=" + result.error : ""}`
      );
      return { status: "error" };
    }
    const html = result.html;
    if (looksBlocked(html)) {
      const head = html.slice(0, 200).replace(/\s+/g, " ");
      console.warn(
        `[peopleSearch] hidden-tab returned blocked HTML on ${url} — first 200 chars:`,
        head
      );
      return { status: "blocked" };
    }
    console.info(
      `[peopleSearch] hidden-tab ok html length=${html.length} on ${url}`
    );
    return { status: "ok", html };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    console.error("[peopleSearch] hidden-tab threw on", url, err);
    return { status: "error" };
  }
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function extractAge(text: string): number | undefined {
  const m = text.match(/\bAge\s*[:\s]\s*(\d{1,3})\b/i);
  if (m) return parseInt(m[1], 10);
  const m2 = text.match(/,\s*(\d{1,3})\b/); // "Name, 47"
  if (m2) {
    const n = parseInt(m2[1], 10);
    if (n >= 1 && n <= 120) return n;
  }
  return undefined;
}

function extractCityState(
  text: string
): { city?: string; state?: string } {
  const m = text.match(/([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2})\b/);
  if (!m) return {};
  return { city: m[1].trim(), state: m[2] };
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// Phone-aware dedupe. Compares by the last 10 digits so "13178625986",
// "3178625986", and "+1 (317) 862-5986" → "3178625986" all collapse.
// Keeps the first occurrence's formatting.
function dedupePhones(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of arr) {
    const tail = (d || "").slice(-10);
    if (tail.length < 7 || seen.has(tail)) continue;
    seen.add(tail);
    out.push(d);
  }
  return out;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse FTN's verbatim "Last reported MMM YYYY" / "Last reported December
// 2018" string to a sortable UTC timestamp. Returns undefined if the
// pattern isn't recognized.
function parseLastReportedDate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i
  );
  if (!m) return undefined;
  const monIdx = MONTH_INDEX[m[1].toLowerCase()];
  const year = parseInt(m[2], 10);
  if (monIdx === undefined || Number.isNaN(year)) return undefined;
  return Date.UTC(year, monIdx, 1);
}

export function lastReportedTimestamp(
  meta: PhoneMeta | undefined
): number | undefined {
  return parseLastReportedDate(meta?.lastReported);
}

// Stable sort of phones by their "Last reported" date (most recent first).
// Phones lacking a parseable date sort to the end, preserving their
// relative input order.
function sortPhonesByLastReported(
  phones: string[],
  phoneMeta: Record<string, PhoneMeta>
): string[] {
  return phones
    .map((digits, i) => ({
      digits,
      i,
      ts: lastReportedTimestamp(phoneMeta[digits.slice(-10)]),
    }))
    .sort((a, b) => {
      if (a.ts === b.ts) return a.i - b.i;
      if (a.ts === undefined) return 1;
      if (b.ts === undefined) return -1;
      return b.ts - a.ts;
    })
    .map((x) => x.digits);
}

interface SiteAdapter {
  source: EnrichmentSource;
  buildUrl(args: {
    first: string;
    last: string;
    city: string;
    state: string;
  }): string;
  parse(
    html: string,
    args?: { first: string; last: string; city: string; state: string }
  ): EnrichmentMatch | null;
}

// One-time diagnostic dump for TruePeopleSearch. Same idea as the FTN
// version: we hit the parser when the markup has shifted, so we surface the
// raw class names + interesting links + the chosen card's HTML so the
// selectors can be updated against real markup.
function dumpTruePeopleSearchDiagnostics(
  doc: Document,
  pickedTop: Element | null
): void {
  const classSet = new Set<string>();
  doc.body?.querySelectorAll("[class]").forEach((el) => {
    el.className
      .toString()
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => classSet.add(c));
  });
  const classes = Array.from(classSet).sort();

  const links: Array<{ href: string; text: string }> = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = (a as HTMLAnchorElement).getAttribute("href") || "";
    if (/\/find\/person\//i.test(href)) {
      links.push({ href, text: textOf(a).slice(0, 120) });
    }
  });

  const dataAttrs = new Set<string>();
  doc.body?.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-")) dataAttrs.add(a.name);
    }
  });

  console.warn(
    "[peopleSearch] truepeoplesearch PARSE DIAG — paste this back so we can update selectors"
  );
  console.warn("[peopleSearch] classes:", classes.slice(0, 200));
  console.warn("[peopleSearch] data-* attrs:", Array.from(dataAttrs).sort());
  console.warn("[peopleSearch] /find/person/ links:", links.slice(0, 30));
  console.warn(
    "[peopleSearch] picked card outerHTML (first 4000 chars):",
    pickedTop ? pickedTop.outerHTML.slice(0, 4000) : "(no card matched)"
  );
  console.warn(
    "[peopleSearch] body text (first 2000 chars):",
    textOf(doc.body).slice(0, 2000)
  );
}

const GENERIC_CTA_NAMES = /^(view details|show more|see more|view profile|details)\s*$/i;

// ---------------------- TruePeopleSearch ----------------------

const truepeoplesearch: SiteAdapter = {
  source: "truepeoplesearch",
  buildUrl({
    first,
    last,
    city,
    state,
  }: {
    first: string;
    last: string;
    city: string;
    state: string;
  }): string {
    const params = new URLSearchParams();
    const name = [first, last].filter(Boolean).join(" ");
    if (name) params.set("name", name);
    const cs = [city, state].filter(Boolean).join(", ");
    if (cs) params.set("citystatezip", cs);
    return `https://www.truepeoplesearch.com/results?${params.toString()}`;
  },
  parse(html: string): EnrichmentMatch | null {
    const cards = parseAllTpsCards(html);
    if (cards.length > 0) return cards[0];
    const doc = new DOMParser().parseFromString(html, "text/html");
    dumpTruePeopleSearchDiagnostics(doc, null);
    return null;
  },
};

// Pull a single TPS result card into an EnrichmentMatch. Returns null if
// the card has no usable name (CTA-only card, or markup we can't parse).
function parseTpsCardElement(top: Element): EnrichmentMatch | null {
  // Name lives in .content-header; the .h4-era selector no longer matches.
  const name = textOf(top.querySelector(".content-header"));
  if (!name || GENERIC_CTA_NAMES.test(name)) return null;

  const blockText = textOf(top);
  const age = extractAge(blockText);
  const { city, state } = extractCityState(blockText);

  // TPS doesn't repeat anchors per relative/address — it renders a single
  // .content-value sibling next to a labeled .content-label, with the
  // entries comma-joined and ellipsis-truncated.
  const relativesRaw = findLabeledValue(top, /related to/i);
  const addressesRaw = findLabeledValue(
    top,
    /used to live in|previous(?:ly)? lived/i
  );

  const relatives = relativesRaw ? splitCommaList(relativesRaw) : [];
  const addresses = addressesRaw ? splitCityList(addressesRaw) : [];

  const detailPath = top.getAttribute("data-detail-link") || "";
  const profileUrl = detailPath
    ? new URL(detailPath, "https://www.truepeoplesearch.com").toString()
    : undefined;

  return {
    name,
    age,
    city,
    state,
    relatives: relatives.length ? dedupe(relatives).slice(0, 12) : undefined,
    addresses: addresses.length ? dedupe(addresses).slice(0, 12) : undefined,
    profileUrl,
  };
}

// Returns every result card on a TPS results page, in DOM order. Used by
// the address+name lookup so we can pick the card whose name matches
// instead of blindly taking the first.
function parseAllTpsCards(html: string): EnrichmentMatch[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Same selector priority as the original single-card parse: prefer cards
  // marked with both [data-detail-link] and .card-summary; fall back to
  // either alone if TPS dropped one.
  let cardEls = Array.from(
    doc.querySelectorAll("[data-detail-link].card-summary")
  );
  if (cardEls.length === 0) {
    cardEls = Array.from(doc.querySelectorAll(".card-summary"));
  }
  if (cardEls.length === 0) {
    cardEls = Array.from(doc.querySelectorAll("[data-detail-link]"));
  }
  const out: EnrichmentMatch[] = [];
  for (const el of cardEls) {
    const m = parseTpsCardElement(el);
    if (m) out.push(m);
  }
  return out;
}

export function normalizePhone(s: string): string {
  return (s || "").replace(/\D+/g, "");
}

const PHONE_RE = /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Pulls phones, emails, and street addresses out of a TPS detail page. TPS
// has used several variants over the years: tel:/mailto: anchors, plain
// .content-value spans next to a "Phone Numbers" / "Email Addresses" label,
// and detail-link anchors that point at /find/phone/ or /find/email/. We try
// all of them and dedupe.
function parseTpsDetail(html: string): {
  phones: string[];
  emails: string[];
  addresses: string[];
} {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const phones: string[] = [];
  const pushPhone = (raw: string) => {
    const digits = normalizePhone(raw);
    if (digits.length >= 10) phones.push(digits);
  };

  // 1. tel: anchors (older / sometimes-still-rendered form).
  doc.querySelectorAll('a[href^="tel:"]').forEach((a) => {
    const raw = (a.getAttribute("href") || "").replace(/^tel:/i, "");
    pushPhone(raw || textOf(a));
  });

  // 2. Anchors that point at a TPS phone-detail page.
  doc
    .querySelectorAll('a[href*="/find/phone/"], a[href*="/phone/"]')
    .forEach((a) => pushPhone(textOf(a)));

  // 3. .content-value blocks next to a "Phone" label.
  for (const label of Array.from(doc.querySelectorAll(".content-label"))) {
    if (!/phone/i.test(textOf(label))) continue;
    const scope = label.parentElement || label;
    for (const v of Array.from(scope.querySelectorAll(".content-value"))) {
      const t = textOf(v);
      const matches = t.match(PHONE_RE);
      if (matches) for (const m of matches) pushPhone(m);
    }
  }

  // 4. Last-resort regex sweep over the document body. This catches phones
  // that live in arbitrary markup TPS may have introduced.
  if (phones.length === 0) {
    const bodyText = textOf(doc.body);
    const matches = bodyText.match(PHONE_RE);
    if (matches) for (const m of matches) pushPhone(m);
  }

  const emails: string[] = [];
  const pushEmail = (raw: string) => {
    const v = (raw || "").trim().toLowerCase();
    if (v && EMAIL_RE.test(v)) {
      EMAIL_RE.lastIndex = 0;
      emails.push(v);
    }
    EMAIL_RE.lastIndex = 0;
  };

  doc.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    pushEmail((a.getAttribute("href") || "").replace(/^mailto:/i, ""));
  });
  for (const label of Array.from(doc.querySelectorAll(".content-label"))) {
    if (!/email/i.test(textOf(label))) continue;
    const scope = label.parentElement || label;
    for (const v of Array.from(scope.querySelectorAll(".content-value"))) {
      const t = textOf(v);
      const matches = t.match(EMAIL_RE);
      if (matches) for (const m of matches) pushEmail(m);
    }
  }

  // Street addresses on the detail page live next to a "Current Address" /
  // "Previous Addresses" label.
  const addresses: string[] = [];
  doc.querySelectorAll(".content-label").forEach((label) => {
    if (!/address/i.test(textOf(label))) return;
    const value = label.parentElement?.querySelector(".content-value");
    const v = textOf(value).trim();
    if (v && /\d/.test(v)) addresses.push(v);
  });

  return {
    phones: dedupePhones(phones),
    emails: dedupe(emails),
    addresses: dedupe(addresses),
  };
}

function dumpTruePeopleSearchDetailDiagnostics(html: string): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const labels = Array.from(doc.querySelectorAll(".content-label")).map((el) =>
    textOf(el)
  );
  const tels = Array.from(doc.querySelectorAll('a[href^="tel:"]')).length;
  const mails = Array.from(doc.querySelectorAll('a[href^="mailto:"]')).length;
  const findPhone = Array.from(
    doc.querySelectorAll('a[href*="/find/phone/"], a[href*="/phone/"]')
  ).length;
  const phoneRegexHits = (textOf(doc.body).match(PHONE_RE) || []).slice(0, 20);

  console.warn(
    "[peopleSearch] tps detail PARSE DIAG — paste this back so we can update selectors"
  );
  console.warn(
    `[peopleSearch] anchor counts: tel=${tels} mailto=${mails} /find/phone/=${findPhone}`
  );
  console.warn("[peopleSearch] .content-label texts:", labels);
  console.warn(
    "[peopleSearch] phone-shaped substrings in body:",
    phoneRegexHits
  );
  console.warn(
    "[peopleSearch] body text (first 2500 chars):",
    textOf(doc.body).slice(0, 2500)
  );
}

// Walk the .content-label spans inside a TPS card and return the text of the
// .content-value sibling whose label matches.
function findLabeledValue(
  scope: Element,
  labelRe: RegExp
): string | undefined {
  const labels = scope.querySelectorAll(".content-label");
  for (const label of Array.from(labels)) {
    if (!labelRe.test(textOf(label))) continue;
    const value = label.parentElement?.querySelector(".content-value");
    if (value) return textOf(value);
  }
  return undefined;
}

function splitCommaList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().replace(/\.{2,}$/, "").trim())
    .filter((s) => s && !/^\.+$/.test(s));
}

// Cities on TPS arrive comma-joined but with inconsistent state-code
// punctuation: "Greenfield, IN, Indianapolis IN, Phoenix...". Re-pair a bare
// 2-letter state code with the city that precedes it.
function splitCityList(text: string): string[] {
  const parts = text
    .split(",")
    .map((s) => s.trim().replace(/\.{2,}$/, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    if (next && /^[A-Z]{2}$/.test(next)) {
      out.push(`${p}, ${next}`);
      i++;
    } else if (p && !/^\.+$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------- FamilyTreeNow ----------------------

// FTN's search-results page (/search/genealogy/results) lists matches as
// anchors with class .linked-record pointing at the per-person detail URL
// /search/people/results?first=…&last=…&citystatezip=…&rid=…&smck=…. The
// detail page is where the rich data lives — phones, full street
// addresses, possible relatives — each rendered as another .linked-record
// with phoneno=, streetaddress=, or personid= query params. We parse the
// search page just enough to pick the top match and grab its detail URL,
// then enrichFtnMatchWithDetail does the heavy lifting on the detail page.
function dumpFamilyTreeNowDiagnostics(
  doc: Document,
  pickedTop: Element | null
): void {
  const classSet = new Set<string>();
  doc.body?.querySelectorAll("[class]").forEach((el) => {
    el.className
      .toString()
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => classSet.add(c));
  });
  const classes = Array.from(classSet).sort();

  const links: Array<{ href: string; text: string }> = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = (a as HTMLAnchorElement).getAttribute("href") || "";
    if (/\/search\/people\/results/i.test(href)) {
      links.push({ href, text: textOf(a).slice(0, 120) });
    }
  });

  console.warn(
    "[peopleSearch] familytreenow PARSE DIAG — paste this back so we can update selectors"
  );
  console.warn("[peopleSearch] classes:", classes.slice(0, 200));
  console.warn(
    "[peopleSearch] /search/people/results links:",
    links.slice(0, 30)
  );
  console.warn(
    "[peopleSearch] picked card outerHTML (first 4000 chars):",
    pickedTop ? pickedTop.outerHTML.slice(0, 4000) : "(no card matched)"
  );
  console.warn(
    "[peopleSearch] body text (first 2000 chars):",
    textOf(doc.body).slice(0, 2000)
  );
}

const familytreenow: SiteAdapter = {
  source: "familytreenow",
  buildUrl({
    first,
    last,
    city,
    state,
  }: {
    first: string;
    last: string;
    city: string;
    state: string;
  }): string {
    const params = new URLSearchParams();
    if (first) params.set("first", first);
    if (last) params.set("last", last);
    const cs = [city, state].filter(Boolean).join(", ");
    if (cs) params.set("citystatezip", cs);
    return `https://www.familytreenow.com/search/genealogy/results?${params.toString()}`;
  },
  parse(
    html: string,
    args?: { first: string; last: string; city: string; state: string }
  ): EnrichmentMatch | null {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Result rows live in #summaryResults; each row has an anchor with class
    // .detail-link going to /search/people/results. Filter by rid= so we
    // skip the left-rail .filter-link variants that share the same path
    // (they have smck= but no rid=).
    const detailLinks = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(
        'a.detail-link[href*="/search/people/results"]'
      )
    ).filter((a) => /[?&]rid=/.test(a.getAttribute("href") || ""));

    if (detailLinks.length === 0) {
      dumpFamilyTreeNowDiagnostics(doc, null);
      return null;
    }

    // Walk every result row and collect candidates so we can rank them
    // instead of always taking detailLinks[0]. FTN's top result is often
    // the wrong person when the input city is malformed upstream — ranking
    // by name + state + city, with older-age as the tiebreaker (more
    // likely the property owner than a younger same-name relative), is
    // sturdier than trusting FTN's own ordering.
    const candidates: FtnCandidate[] = [];
    for (let i = 0; i < detailLinks.length; i++) {
      const link = detailLinks[i];
      const row =
        link.closest("tr") ?? link.closest(".row") ?? link.parentElement;
      if (!row) continue;

      const nameEl = row.querySelector(".seo-heading");
      const name = textOf(nameEl);
      if (!name) continue;

      // The anchor text is generic ("People Records" / "View Details"); the
      // real name lives in h2.seo-heading inside the same row, and age /
      // location appear in labeled cells of the .table-nested next to it.
      const labeledValue = (re: RegExp): string | undefined => {
        const labels = row.querySelectorAll(".text-uppercase");
        for (const label of Array.from(labels)) {
          if (!re.test(textOf(label))) continue;
          const parent = label.parentElement;
          if (!parent) continue;
          const cells = Array.from(parent.children);
          const idx = cells.indexOf(label);
          if (idx >= 0 && cells[idx + 1]) {
            const v = textOf(cells[idx + 1]).trim();
            if (v) return v;
          }
        }
        return undefined;
      };

      const livesIn = labeledValue(/lives in/i);
      let city = "";
      let state = "";
      if (livesIn) {
        const cs = extractCityState(livesIn);
        city = cs.city ?? "";
        state = cs.state ?? "";
      }

      const ageText = labeledValue(/^age/i);
      const age = ageText ? extractAge(`Age ${ageText}`) : undefined;

      const profilePath = link.getAttribute("href") || "";
      const profileUrl = profilePath
        ? new URL(profilePath, "https://www.familytreenow.com").toString()
        : undefined;

      candidates.push({ name, age, city, state, profileUrl, _index: i });
    }

    if (candidates.length === 0) {
      dumpFamilyTreeNowDiagnostics(doc, detailLinks[0].parentElement);
      return null;
    }

    const picked = pickFtnCandidate(candidates, args);
    if (!picked) {
      const summary = candidates
        .map((c) => `${c.name}${c.age ? "/" + c.age : ""}`)
        .join("; ");
      console.info(
        `[peopleSearch] familytreenow: ${candidates.length} candidate(s) [${summary}] but none matched last name "${args?.last ?? ""}"`
      );
      return null;
    }

    if (candidates.length > 1) {
      const summary = candidates
        .map(
          (c) =>
            `${c.name}${c.age ? "/" + c.age : ""}${
              c.state ? "/" + c.state : ""
            }`
        )
        .join("; ");
      console.info(
        `[peopleSearch] familytreenow: picked "${picked.name}"${
          picked.age ? ", age " + picked.age : ""
        } from ${candidates.length} candidate(s) [${summary}]`
      );
    }

    const { _index, ...match } = picked;
    return match;
  },
};

type FtnCandidate = EnrichmentMatch & { _index: number };

// Rank FTN search-result candidates against the input. Last-name match is a
// hard requirement when we have one — picking a wrong-last-name top result
// burns a detail fetch and caches a bad enrichment. Among same-last-name
// candidates: first-name match is strongest, then state, then city. Ties
// break to the older candidate (more likely the property owner), then to
// FTN's own page order. When called without args (e.g., the address-only
// FTN lookup path), the filter and scoring degrade to "oldest wins, page
// order tiebreaks."
function pickFtnCandidate(
  candidates: FtnCandidate[],
  args?: { first: string; last: string; city: string; state: string }
): FtnCandidate | null {
  const inFirst = (args?.first ?? "").trim();
  const inLast = (args?.last ?? "").trim();
  const inCity = normalizeCityForCompare(args?.city ?? "");
  const inState = (args?.state ?? "").trim().toUpperCase();

  const firstWord = (s: string): string =>
    s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const stripSuffix = (s: string): string =>
    s.replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, "").trim();

  let pool = candidates;
  if (inLast) {
    const want = inLast.toLowerCase();
    pool = candidates.filter((c) => {
      const cn = splitName(stripSuffix(c.name));
      return cn.last.toLowerCase() === want;
    });
    if (pool.length === 0) return null;
  }

  const scoreOf = (c: FtnCandidate): number => {
    let s = 0;
    if (inFirst) {
      const cn = splitName(stripSuffix(c.name));
      if (firstWord(cn.first) === firstWord(inFirst)) s += 3;
    }
    if (inState && (c.state || "").trim().toUpperCase() === inState) s += 2;
    if (inCity && normalizeCityForCompare(c.city || "") === inCity) s += 1;
    return s;
  };

  return [...pool].sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sb !== sa) return sb - sa;
    const ageA = a.age ?? -1;
    const ageB = b.age ?? -1;
    if (ageB !== ageA) return ageB - ageA;
    return a._index - b._index;
  })[0];
}

function normalizeCityForCompare(city: string): string {
  return (city || "")
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/\bst\.\s*/g, "st ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Pulls phones, addresses, and relatives off an FTN /search/people/results
// detail page. Each of those lives in its own panel with a distinct
// linked-record href shape, which is the stable selector — class names on
// the surrounding panels have churned more.
function parseFtnDetail(html: string): {
  phones: string[];
  phoneMeta: Record<string, PhoneMeta>;
  addresses: string[];
  relatives: string[];
} {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const phones: string[] = [];
  const phoneMeta: Record<string, PhoneMeta> = {};
  doc
    .querySelectorAll<HTMLAnchorElement>(
      'a.linked-record[href*="phoneno="]'
    )
    .forEach((a) => {
      const digits = normalizePhone(textOf(a));
      if (digits.length < 10) return;
      phones.push(digits);

      // The phone block: <div><a>...</a> - <span class="smaller">Type</span>
      // <div class="dt-ln"><span class="dt-sb">Last reported …</span><span
      // class="dt-sb">Carrier</span><span class="dt-sb">Possible Primary
      // Phone</span></div></div>
      const block = a.closest("div");
      if (!block) return;
      const meta: PhoneMeta = {};
      const typeSpan = block.querySelector(".smaller");
      const typeText = textOf(typeSpan);
      if (typeText) meta.type = typeText;

      for (const span of Array.from(block.querySelectorAll(".dt-sb"))) {
        const t = textOf(span);
        if (!t) continue;
        if (/^last reported/i.test(t)) {
          meta.lastReported = t;
        } else if (!meta.carrier && !/possible primary/i.test(t)) {
          meta.carrier = t;
        }
      }

      if (meta.type || meta.lastReported || meta.carrier) {
        phoneMeta[digits.slice(-10)] = meta;
      }
    });

  // Each address anchor's text is "<street>\n<City>, <ST> <ZIP>"; collapse
  // to a single comma-joined line so the corroboration matchers can compare
  // against TPS / Reonomy formats.
  const addresses: string[] = [];
  doc
    .querySelectorAll<HTMLAnchorElement>(
      'a.linked-record[href*="streetaddress="]'
    )
    .forEach((a) => {
      const text = textOf(a);
      if (!text || !/\d/.test(text)) return;
      addresses.push(text);
    });

  // Possible Relatives — the personid= query is unique to that panel,
  // which keeps us from sweeping in "Associated Names" (the matched
  // person's own name variants).
  const relatives: string[] = [];
  doc
    .querySelectorAll<HTMLAnchorElement>(
      'a.linked-record[href*="personid="]'
    )
    .forEach((a) => {
      const text = textOf(a);
      if (text && !GENERIC_CTA_NAMES.test(text)) relatives.push(text);
    });

  return {
    phones: sortPhonesByLastReported(dedupePhones(phones), phoneMeta),
    phoneMeta,
    addresses: dedupe(addresses),
    relatives: dedupe(relatives),
  };
}

function dumpFamilyTreeNowDetailDiagnostics(html: string): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const linkedRecords = Array.from(
    doc.querySelectorAll<HTMLAnchorElement>("a.linked-record")
  ).map((a) => ({
    href: a.getAttribute("href") || "",
    text: textOf(a).slice(0, 120),
  }));
  const headings = Array.from(
    doc.querySelectorAll(".panel-heading h2, .panel-heading h3")
  ).map((el) => textOf(el));

  console.warn(
    "[peopleSearch] ftn detail PARSE DIAG — paste this back so we can update selectors"
  );
  console.warn("[peopleSearch] panel headings:", headings);
  console.warn(
    "[peopleSearch] .linked-record anchors (first 40):",
    linkedRecords.slice(0, 40)
  );
  console.warn(
    "[peopleSearch] body text (first 2000 chars):",
    textOf(doc.body).slice(0, 2000)
  );
}

async function enrichFtnMatchWithDetail(
  match: EnrichmentMatch,
  signal?: AbortSignal
): Promise<EnrichmentMatch> {
  if (!match.profileUrl) {
    console.warn(
      "[peopleSearch] ftn match has no profileUrl — detail fetch skipped"
    );
    return match;
  }
  console.info(`[peopleSearch] fetching ftn detail page ${match.profileUrl}`);
  try {
    const detail = await fetchHtml(match.profileUrl, signal);
    if (detail.status !== "ok") {
      console.warn(
        `[peopleSearch] ftn detail fetch ${detail.status} for ${match.profileUrl}`
      );
      return match;
    }
    const parsed = parseFtnDetail(detail.html);
    console.info(
      `[peopleSearch] ftn detail parsed: phones=${parsed.phones.length} addresses=${parsed.addresses.length} relatives=${parsed.relatives.length} (html ${detail.html.length} bytes)`
    );
    if (
      parsed.phones.length === 0 &&
      parsed.addresses.length === 0 &&
      parsed.relatives.length === 0
    ) {
      dumpFamilyTreeNowDetailDiagnostics(detail.html);
    }
    const hasMeta = Object.keys(parsed.phoneMeta).length > 0;
    return {
      ...match,
      phones: parsed.phones.length ? parsed.phones : match.phones,
      phoneMeta: hasMeta ? parsed.phoneMeta : match.phoneMeta,
      addresses: parsed.addresses.length
        ? dedupe(parsed.addresses).slice(0, 12)
        : match.addresses,
      relatives: parsed.relatives.length
        ? dedupe(parsed.relatives).slice(0, 12)
        : match.relatives,
    };
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      console.warn("[peopleSearch] ftn detail fetch threw", err);
    }
    return match;
  }
}

// ---------------------- Orchestrator ----------------------

async function runAdapter(
  adapter: SiteAdapter,
  args: { first: string; last: string; city: string; state: string },
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const url = adapter.buildUrl(args);
  const fetched = await fetchHtml(url, signal);
  const fetchedAt = new Date().toISOString();
  if (fetched.status !== "ok") {
    const status: EnrichmentStatus = fetched.status;
    console.info(
      `[peopleSearch] ${adapter.source}: ${status} for "${args.first} ${args.last}" (${args.city}, ${args.state})`
    );
    return { source: adapter.source, status, fetchedAt };
  }
  const match = adapter.parse(fetched.html, args);
  if (!match) {
    console.warn(
      `[peopleSearch] ${adapter.source}: parse returned no match for "${args.first} ${args.last}" — selectors may need updating`
    );
    return { source: adapter.source, status: "no_match", fetchedAt };
  }
  console.info(
    `[peopleSearch] ${adapter.source}: matched "${match.name}"${match.age ? ", " + match.age : ""}`
  );
  return { source: adapter.source, status: "ok", match, fetchedAt };
}

async function enrichTpsMatchWithDetail(
  match: EnrichmentMatch,
  signal?: AbortSignal
): Promise<EnrichmentMatch> {
  if (!match.profileUrl) {
    console.warn(
      "[peopleSearch] tps match has no profileUrl — detail fetch skipped"
    );
    return match;
  }
  console.info(`[peopleSearch] fetching tps detail page ${match.profileUrl}`);
  try {
    const detail = await fetchHtml(match.profileUrl, signal);
    if (detail.status !== "ok") {
      console.warn(
        `[peopleSearch] tps detail fetch ${detail.status} for ${match.profileUrl}`
      );
      return match;
    }
    const parsed = parseTpsDetail(detail.html);
    console.info(
      `[peopleSearch] tps detail parsed: phones=${parsed.phones.length} emails=${parsed.emails.length} addresses=${parsed.addresses.length} (html ${detail.html.length} bytes)`
    );
    if (parsed.phones.length === 0) {
      dumpTruePeopleSearchDetailDiagnostics(detail.html);
    }
    return {
      ...match,
      phones: parsed.phones.length ? parsed.phones : undefined,
      emails: parsed.emails.length ? parsed.emails : undefined,
      // Prefer street addresses from the detail page when we have them;
      // otherwise keep the prior-cities list from the search card.
      addresses: parsed.addresses.length
        ? dedupe(parsed.addresses).slice(0, 12)
        : match.addresses,
    };
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      console.warn("[peopleSearch] tps detail fetch threw", err);
    }
    return match;
  }
}

// Combine results from both adapters into a single match. TPS is the only
// source for phones/emails (FTN doesn't surface them), so when it matched
// we treat it as primary; otherwise FTN's data stands on its own. Relatives
// and addresses are unioned across sources.
function mergeEnrichmentResults(
  tps: EnrichmentResult,
  ftn: EnrichmentResult
): EnrichmentResult {
  const tpsMatch = tps.status === "ok" ? tps.match : undefined;
  const ftnMatch = ftn.status === "ok" ? ftn.match : undefined;

  if (!tpsMatch && !ftnMatch) {
    // Surface the more-informative status — `blocked` beats `error` beats
    // `no_match` when reporting why we have nothing.
    const rank: Record<EnrichmentStatus, number> = {
      ok: 0,
      blocked: 3,
      error: 2,
      no_match: 1,
    };
    const worse = rank[tps.status] >= rank[ftn.status] ? tps : ftn;
    return {
      source: worse.source,
      status: worse.status,
      fetchedAt: new Date().toISOString(),
    };
  }

  const primary = tpsMatch ?? ftnMatch!;
  const secondary = tpsMatch ? ftnMatch : undefined;

  const merged: EnrichmentMatch = { ...primary };
  if (secondary) {
    if (secondary.phones?.length) {
      merged.phones = dedupePhones([
        ...(merged.phones ?? []),
        ...secondary.phones,
      ]).slice(0, 12);
    }
    if (secondary.phoneMeta) {
      // Primary's meta wins when both sides have a record for the same tail.
      merged.phoneMeta = {
        ...secondary.phoneMeta,
        ...(merged.phoneMeta ?? {}),
      };
    }
    if (secondary.emails?.length) {
      merged.emails = dedupe([
        ...(merged.emails ?? []),
        ...secondary.emails,
      ]).slice(0, 12);
    }
    if (secondary.relatives?.length) {
      merged.relatives = dedupe([
        ...(merged.relatives ?? []),
        ...secondary.relatives,
      ]).slice(0, 12);
    }
    if (secondary.addresses?.length) {
      merged.addresses = dedupe([
        ...(merged.addresses ?? []),
        ...secondary.addresses,
      ]).slice(0, 12);
    }
    if (merged.age === undefined && secondary.age !== undefined) {
      merged.age = secondary.age;
    }
    if (!merged.city && secondary.city) merged.city = secondary.city;
    if (!merged.state && secondary.state) merged.state = secondary.state;
  }

  // Re-sort the final phone list by last-reported date so the most-recent
  // numbers float to the top regardless of which source provided them.
  if (merged.phones && merged.phoneMeta) {
    merged.phones = sortPhonesByLastReported(merged.phones, merged.phoneMeta);
  }

  const bySource: Partial<Record<EnrichmentSource, EnrichmentMatch>> = {};
  if (tpsMatch) bySource.truepeoplesearch = tpsMatch;
  if (ftnMatch) bySource.familytreenow = ftnMatch;

  return {
    source: tpsMatch ? "truepeoplesearch" : "familytreenow",
    status: "ok",
    match: merged,
    bySource,
    fetchedAt: new Date().toISOString(),
  };
}

export async function searchPerson(
  input: PersonInput,
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const { first, last } = splitName(input.fullName);
  const { city, state } = resolveLocation(input);
  const key = keyFor(first, last, city, state);

  if (!first && !last) {
    console.warn("[peopleSearch] no name to search; skipping", input);
    return {
      source: "truepeoplesearch",
      status: "no_match",
      fetchedAt: new Date().toISOString(),
    };
  }

  const cached = await getCached(key);
  if (cached) {
    console.info(`[peopleSearch] cache hit (${cached.status}) for ${key}`);
    return cached;
  }
  console.info(`[peopleSearch] cache miss for ${key} — fetching`);

  // FTN is the primary source — its captcha auto-submit usually clears and
  // it carries the data we lean on (phones with dates, relatives,
  // addresses). TPS only runs when FTN comes back `blocked` (captcha or
  // IP rate-limit), so we don't spend a fetch on TPS when FTN already
  // succeeded or returned a clean no_match.
  const args = { first, last, city, state };
  const runFtn = async (): Promise<EnrichmentResult> => {
    let r = await runAdapter(familytreenow, args, signal);
    if (r.status === "ok" && r.match) {
      r = { ...r, match: await enrichFtnMatchWithDetail(r.match, signal) };
    }
    return r;
  };
  const runTps = async (): Promise<EnrichmentResult> => {
    // When we have the property's street address, prefer TPS's reverse-
    // address endpoint and pick the resident whose name matches the owner.
    // This is sharper than name + citystatezip because /resultaddress is
    // already filtered to people who live at the address — we then name-
    // match instead of trusting TPS's ranking among same-city namesakes.
    if (input.address) {
      const r = await runTpsAddressNameLookup(
        input.address,
        input.fullName,
        signal
      );
      if (r.status === "ok" || r.status === "blocked") return r;
      // no_match / error → fall through to plain name + citystatezip search
    }
    let r = await runAdapter(truepeoplesearch, args, signal);
    if (r.status === "ok" && r.match) {
      r = { ...r, match: await enrichTpsMatchWithDetail(r.match, signal) };
    }
    return r;
  };

  const ftnResult = await runFtn();
  let tpsResult: EnrichmentResult = {
    source: "truepeoplesearch",
    status: "no_match",
    fetchedAt: new Date().toISOString(),
  };
  if (ftnResult.status === "blocked") {
    console.info(`[peopleSearch] ftn blocked for ${key} — falling back to tps`);
    tpsResult = await runTps();
  }

  const merged = mergeEnrichmentResults(tpsResult, ftnResult);
  await setCached(key, merged);
  return merged;
}

// ---------------------- Reverse-address lookup ----------------------

// Cache key for an address-only lookup. Lowercased + whitespace-normalized so
// minor formatting differences across scrapes hit the same entry.
export function addressLookupKey(address: string): string {
  return `addr:${(address || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// FTN's genealogy form posts to the same /search/genealogy/results endpoint
// with StreetAddress / CityStateZip params, so we reuse the search-results
// parser by just feeding it that URL.
function buildFtnAddressUrl(address: string): string {
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Heuristic: first segment is the street, the rest is "city, ST [zip]".
  const street = parts[0] ?? "";
  const cityStateZip = parts.slice(1).join(", ");
  const params = new URLSearchParams();
  if (street) params.set("StreetAddress", street);
  if (cityStateZip) params.set("CityStateZip", cityStateZip);
  return `https://www.familytreenow.com/search/genealogy/results?${params.toString()}`;
}

// TPS's reverse-address page is /resultaddress with the same .card-summary
// markup as the by-name results page, so the existing truepeoplesearch
// parser handles it as-is.
function buildTpsAddressUrl(address: string): string {
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const street = parts[0] ?? "";
  const cityStateZip = parts.slice(1).join(", ");
  const params = new URLSearchParams();
  if (street) params.set("streetaddress", street);
  if (cityStateZip) params.set("citystatezip", cityStateZip);
  return `https://www.truepeoplesearch.com/resultaddress?${params.toString()}`;
}

async function runFtnAddressLookup(
  norm: string,
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const fetchedAt = new Date().toISOString();
  const url = buildFtnAddressUrl(norm);
  console.info(`[peopleSearch] ftn address lookup url: ${url}`);
  const fetched = await fetchHtml(url, signal);
  if (fetched.status !== "ok") {
    return { source: "familytreenow", status: fetched.status, fetchedAt };
  }
  const baseMatch = familytreenow.parse(fetched.html);
  if (!baseMatch) {
    return { source: "familytreenow", status: "no_match", fetchedAt };
  }
  const enriched = await enrichFtnMatchWithDetail(baseMatch, signal);
  return {
    source: "familytreenow",
    status: "ok",
    match: enriched,
    bySource: { familytreenow: enriched },
    fetchedAt,
  };
}

// Owner-aware variant of runTpsAddressLookup: hits /resultaddress to enumerate
// residents at the property, then picks the card whose name matches the
// owner. Used by searchPerson when an address is available — it avoids the
// "first card wins" failure mode of name + citystatezip search where TPS
// returns several namesakes in the same city.
async function runTpsAddressNameLookup(
  address: string,
  fullName: string,
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const fetchedAt = new Date().toISOString();
  const url = buildTpsAddressUrl(address);
  console.info(
    `[peopleSearch] tps address+name lookup url: ${url} (looking for "${fullName}")`
  );
  const fetched = await fetchHtml(url, signal);
  if (fetched.status !== "ok") {
    return { source: "truepeoplesearch", status: fetched.status, fetchedAt };
  }
  const candidates = parseAllTpsCards(fetched.html);
  if (candidates.length === 0) {
    console.info(`[peopleSearch] tps reverse-address returned no resident cards`);
    return { source: "truepeoplesearch", status: "no_match", fetchedAt };
  }
  const match = pickByOwnerName(candidates, fullName);
  if (!match) {
    const names = candidates.map((c) => c.name).join("; ");
    console.info(
      `[peopleSearch] tps reverse-address found ${candidates.length} resident(s) [${names}] but none matched "${fullName}"`
    );
    return { source: "truepeoplesearch", status: "no_match", fetchedAt };
  }
  console.info(
    `[peopleSearch] tps reverse-address matched "${match.name}" for owner "${fullName}"`
  );
  const enriched = await enrichTpsMatchWithDetail(match, signal);
  return {
    source: "truepeoplesearch",
    status: "ok",
    match: enriched,
    bySource: { truepeoplesearch: enriched },
    fetchedAt,
  };
}

// Strict-then-loose name match across resident candidates. Strict: first
// word of first name + last name match exactly. We don't fall back to
// last-name + first-initial because at a single address that picks up
// siblings/spouses of the actual owner.
function pickByOwnerName(
  candidates: EnrichmentMatch[],
  fullName: string
): EnrichmentMatch | null {
  const owner = splitName(fullName);
  if (!owner.first || !owner.last) return null;
  const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const oFirst = firstWord(owner.first);
  const oLast = owner.last.toLowerCase();
  for (const c of candidates) {
    const cn = splitName(c.name);
    if (!cn.first || !cn.last) continue;
    if (firstWord(cn.first) === oFirst && cn.last.toLowerCase() === oLast) {
      return c;
    }
  }
  return null;
}

async function runTpsAddressLookup(
  norm: string,
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const fetchedAt = new Date().toISOString();
  const url = buildTpsAddressUrl(norm);
  console.info(`[peopleSearch] tps address lookup url: ${url}`);
  const fetched = await fetchHtml(url, signal);
  if (fetched.status !== "ok") {
    return { source: "truepeoplesearch", status: fetched.status, fetchedAt };
  }
  const baseMatch = truepeoplesearch.parse(fetched.html);
  if (!baseMatch) {
    return { source: "truepeoplesearch", status: "no_match", fetchedAt };
  }
  const enriched = await enrichTpsMatchWithDetail(baseMatch, signal);
  return {
    source: "truepeoplesearch",
    status: "ok",
    match: enriched,
    bySource: { truepeoplesearch: enriched },
    fetchedAt,
  };
}

// Reverse-address lookup: find a likely resident at the given address via
// FTN, then enrich with phones/relatives/addresses from the detail page.
// Used as a fallback when Reonomy returns no person owners but does give us
// a property/mailing address to pivot from. Falls through to TPS when FTN
// can't find a match (or is blocked / errors out) so we still get a hit
// when only one of the two sources knows the resident.
export async function searchByAddress(
  address: string,
  signal?: AbortSignal
): Promise<EnrichmentResult> {
  const norm = (address || "").trim();
  if (!norm) {
    return {
      source: "familytreenow",
      status: "no_match",
      fetchedAt: new Date().toISOString(),
    };
  }

  const cacheKey = addressLookupKey(norm);
  const cached = await getCached(cacheKey);
  if (cached) {
    console.info(
      `[peopleSearch] cache hit (${cached.status}) for ${cacheKey}`
    );
    return cached;
  }
  console.info(`[peopleSearch] cache miss for ${cacheKey} — address fetching`);

  const ftn = await runFtnAddressLookup(norm, signal);
  if (ftn.status === "ok") {
    await setCached(cacheKey, ftn);
    return ftn;
  }

  console.info(
    `[peopleSearch] ftn address lookup ${ftn.status} for ${cacheKey} — falling back to tps`
  );
  const tps = await runTpsAddressLookup(norm, signal);
  const final = tps.status === "ok" ? tps : ftn;
  await setCached(cacheKey, final);
  return final;
}

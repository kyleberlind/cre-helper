import type {
  Contact,
  EnrichmentMatch,
  EnrichmentResult,
  EnrichmentSource,
  Owner,
  Phone,
  PhoneMeta,
} from "../types";
import {
  lastReportedTimestamp,
  normalizePhone,
  sourcesCorroboratingAddress,
  sourcesCorroboratingEmail,
  sourcesCorroboratingName,
  sourcesCorroboratingPhone,
  splitName,
} from "../lib/peopleSearch";
import { PeopleSearchLinks } from "./PeopleSearchLinks";

// FTN's genealogy search URL — splits the relative's name into first/last
// and adds the matched person's city/state when known so the lookup lands
// on a tighter result set.
function ftnLookupUrl(fullName: string, city?: string, state?: string): string {
  const { first, last } = splitName(fullName);
  const params = new URLSearchParams();
  if (first) params.set("first", first);
  if (last) params.set("last", last);
  const cs = [city, state].filter(Boolean).join(", ");
  if (cs) params.set("citystatezip", cs);
  return `https://www.familytreenow.com/search/genealogy/results?${params.toString()}`;
}

function formatPhone(digits: string): string {
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

// Phones surfaced by the enrichment that aren't already on the owner card,
// each tagged with the adapter(s) that vouch for it. Comparison is by last
// 10 digits to ignore +1 / leading-1 differences and formatting noise.
function enrichmentOnlyPhones(
  ownerPhones: Phone[],
  result: EnrichmentResult | undefined
): Array<{
  digits: string;
  sources: EnrichmentSource[];
  meta?: PhoneMeta;
}> {
  if (!result?.match?.phones?.length) return [];
  const ownerTails = new Set(
    ownerPhones
      .map((p) => normalizePhone(p.number).slice(-10))
      .filter((t) => t.length >= 7)
  );
  const seen = new Set<string>();
  const out: Array<{
    digits: string;
    sources: EnrichmentSource[];
    meta?: PhoneMeta;
  }> = [];
  const phoneMeta = result.match.phoneMeta;
  for (const digits of result.match.phones) {
    const tail = digits.slice(-10);
    if (tail.length < 7) continue;
    if (ownerTails.has(tail) || seen.has(tail)) continue;
    seen.add(tail);
    out.push({
      digits,
      sources: sourcesCorroboratingPhone(digits, result),
      meta: phoneMeta?.[tail],
    });
  }
  return out;
}

// Pretty-print phone metadata as a " · "-joined dim suffix.
function formatPhoneMeta(meta: PhoneMeta | undefined): string {
  if (!meta) return "";
  return [meta.type, meta.lastReported, meta.carrier]
    .filter(Boolean)
    .join(" · ");
}

// Sort Reonomy-listed phones by their FTN last-reported date (most recent
// first); phones we have no metadata for keep their original relative
// order at the bottom.
function sortOwnerPhonesByLastReported(
  phones: Phone[],
  result: EnrichmentResult | undefined
): Phone[] {
  const meta = result?.match?.phoneMeta;
  if (!meta) return phones;
  return phones
    .map((p, i) => ({
      p,
      i,
      ts: lastReportedTimestamp(meta[normalizePhone(p.number).slice(-10)]),
    }))
    .sort((a, b) => {
      if (a.ts === b.ts) return a.i - b.i;
      if (a.ts === undefined) return 1;
      if (b.ts === undefined) return -1;
      return b.ts - a.ts;
    })
    .map((x) => x.p);
}

type EnrichmentState = EnrichmentResult | "pending" | undefined;

function activeMatch(enrichment: EnrichmentState): EnrichmentMatch | undefined {
  if (!enrichment || enrichment === "pending") return undefined;
  return enrichment.status === "ok" ? enrichment.match : undefined;
}

function activeResult(
  enrichment: EnrichmentState
): EnrichmentResult | undefined {
  if (!enrichment || enrichment === "pending") return undefined;
  return enrichment.status === "ok" ? enrichment : undefined;
}

const CORROBORATED_CLASS = "text-emerald-600 dark:text-emerald-400 font-medium";

function formatSources(sources: EnrichmentSource[]): string {
  return sources.join(" + ");
}

// Which adapters actually contributed a match. Falls back to the result's
// primary source if bySource is missing (e.g. a cached pre-bySource entry).
function matchedSources(result: EnrichmentResult): EnrichmentSource[] {
  if (result.bySource) {
    const out: EnrichmentSource[] = [];
    if (result.bySource.truepeoplesearch) out.push("truepeoplesearch");
    if (result.bySource.familytreenow) out.push("familytreenow");
    if (out.length) return out;
  }
  return [result.source];
}

function CorroboratedBadge({
  sources,
  verb = "corroborated by",
}: {
  sources: EnrichmentSource[];
  verb?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
      ✓ {verb} {formatSources(sources)}
    </span>
  );
}

interface Props {
  owner: Owner | Contact;
  enrichment?: EnrichmentState;
}

export function OwnerCard({ owner, enrichment }: Props) {
  const parentCompany = "parentCompany" in owner ? owner.parentCompany : undefined;
  const role = "role" in owner ? owner.role : undefined;
  const kind = "kind" in owner ? owner.kind : undefined;
  const isPerson = kind !== "company";
  const subline = [parentCompany ? `Via ${parentCompany}` : null, role]
    .filter(Boolean)
    .join(" · ");
  const profileUrl = owner.profileUrl;
  const match = activeMatch(enrichment);
  const result = activeResult(enrichment);
  const nameSources = isPerson
    ? sourcesCorroboratingName(owner.name, result)
    : [];
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-3 mb-3">
      <h2 className="text-sm font-semibold">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {owner.name || "(unnamed)"}
          </a>
        ) : (
          owner.name || "(unnamed)"
        )}
        <CorroboratedBadge sources={nameSources} verb="found in" />
      </h2>
      {subline && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {subline}
        </div>
      )}
      {owner.title && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {owner.title}
        </div>
      )}
      <div className="mb-2" />

      {(() => {
        const extraPhones = enrichmentOnlyPhones(owner.phones, result);
        if (owner.phones.length === 0 && extraPhones.length === 0) return null;
        const sortedOwnerPhones = sortOwnerPhonesByLastReported(
          owner.phones,
          result
        );
        return (
          <Section title="Phone Numbers">
            {sortedOwnerPhones.map((p, i) => {
              const sources = sourcesCorroboratingPhone(p.number, result);
              const corroborated = sources.length > 0;
              const tail = normalizePhone(p.number).slice(-10);
              const metaText = formatPhoneMeta(
                tail ? result?.match?.phoneMeta?.[tail] : undefined
              );
              const reonomyMeta = [p.entity, p.type].filter(Boolean).join(" · ");
              const suffix = [reonomyMeta, metaText].filter(Boolean).join(" · ");
              return (
                <li
                  key={`r-${i}`}
                  className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
                >
                  <a
                    href={`tel:${p.number.replace(/[^\d+]/g, "")}`}
                    className={
                      corroborated
                        ? `${CORROBORATED_CLASS} hover:underline`
                        : "text-accent hover:underline"
                    }
                  >
                    {p.number}
                  </a>
                  {suffix && (
                    <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {suffix}
                    </span>
                  )}
                  <CorroboratedBadge sources={sources} />
                </li>
              );
            })}
            {extraPhones.map(({ digits, sources, meta }, i) => {
              const metaText = formatPhoneMeta(meta);
              const viaText = `via ${
                sources.length ? formatSources(sources) : "enrichment"
              }`;
              const suffix = [metaText, viaText].filter(Boolean).join(" · ");
              return (
                <li
                  key={`e-${i}`}
                  className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
                >
                  <a
                    href={`tel:${digits}`}
                    className="text-accent hover:underline"
                  >
                    {formatPhone(digits)}
                  </a>
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {suffix}
                  </span>
                </li>
              );
            })}
          </Section>
        );
      })()}

      {owner.emails.length > 0 && (
        <Section title="Emails">
          {owner.emails.map((e, i) => {
            const sources = sourcesCorroboratingEmail(e, result);
            const corroborated = sources.length > 0;
            return (
              <li
                key={i}
                className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
              >
                <a
                  href={`mailto:${e}`}
                  className={
                    corroborated
                      ? `${CORROBORATED_CLASS} hover:underline`
                      : "text-accent hover:underline"
                  }
                >
                  {e}
                </a>
                <CorroboratedBadge sources={sources} />
              </li>
            );
          })}
        </Section>
      )}

      {owner.addresses.length > 0 && (
        <Section title="Addresses">
          {owner.addresses.map((a, i) => {
            const sources = sourcesCorroboratingAddress(a, result);
            const corroborated = sources.length > 0;
            return (
              <li
                key={i}
                className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
              >
                <span className={corroborated ? CORROBORATED_CLASS : undefined}>
                  {a}
                </span>
                <CorroboratedBadge sources={sources} />
              </li>
            );
          })}
        </Section>
      )}

      {match && match.relatives && match.relatives.length > 0 && (
        <RelativesSection
          relatives={match.relatives}
          city={match.city}
          state={match.state}
        />
      )}

      {isPerson && (
        <EnrichmentBlock
          fullName={owner.name}
          addresses={owner.addresses}
          enrichment={enrichment}
        />
      )}
    </div>
  );
}

function EnrichmentBlock({
  fullName,
  addresses,
  enrichment,
}: {
  fullName: string;
  addresses: string[];
  enrichment: EnrichmentState;
}) {
  if (enrichment === "pending") {
    return (
      <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 italic">
        Looking up…
      </div>
    );
  }
  if (enrichment && enrichment.status === "ok" && enrichment.match) {
    return (
      <Match result={enrichment} addresses={addresses} fullName={fullName} />
    );
  }
  // No enrichment yet, or auto-lookup failed: fall back to manual links.
  const titleAttr =
    enrichment && enrichment.status !== "ok"
      ? `auto-lookup ${enrichment.status} via ${enrichment.source}`
      : undefined;
  return (
    <div title={titleAttr}>
      <PeopleSearchLinks fullName={fullName} addresses={addresses} />
    </div>
  );
}

function Match({
  result,
  fullName,
  addresses,
}: {
  result: EnrichmentResult;
  fullName: string;
  addresses: string[];
}) {
  const m = result.match!;
  const headParts = [
    m.name,
    typeof m.age === "number" ? String(m.age) : null,
  ].filter(Boolean);
  const head = headParts.join(", ");
  const loc = [m.city, m.state].filter(Boolean).join(", ");
  return (
    <div className="mt-3 rounded border border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/40 p-2">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 font-semibold">
        Top match
      </div>
      <div className="text-xs mt-0.5 break-words">
        <span className="font-medium">{head}</span>
        {loc && (
          <span className="text-neutral-500 dark:text-neutral-400">
            {" · "}
            {loc}
          </span>
        )}
      </div>
      <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
        via {formatSources(matchedSources(result))}
      </div>
      <div className="mt-1">
        <PeopleSearchLinks fullName={fullName} addresses={addresses} />
      </div>
    </div>
  );
}

function RelativesSection({
  relatives,
  city,
  state,
}: {
  relatives: string[];
  city?: string;
  state?: string;
}) {
  return (
    <Section title="Relatives">
      {relatives.map((r, i) => {
        const { first, last } = splitName(r);
        const looksLikeName = !!(first && last);
        return (
          <li
            key={i}
            className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words flex items-center justify-between gap-2"
          >
            <span>{r}</span>
            {looksLikeName && (
              <a
                href={ftnLookupUrl(r, city, state)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-accent hover:underline shrink-0"
              >
                Look up
              </a>
            )}
          </li>
        );
      })}
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <h3 className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1 font-semibold">
        {title}
      </h3>
      <ul className="m-0 p-0 list-none text-xs">{children}</ul>
    </div>
  );
}

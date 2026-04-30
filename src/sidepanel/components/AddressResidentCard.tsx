import type { EnrichmentMatch, EnrichmentResult, PhoneMeta } from "../types";
import { normalizePhone, splitName } from "../lib/peopleSearch";

function formatPhoneMeta(meta: PhoneMeta | undefined): string {
  if (!meta) return "";
  return [meta.type, meta.lastReported, meta.carrier]
    .filter(Boolean)
    .join(" · ");
}

type EnrichmentState = EnrichmentResult | "pending" | undefined;

function formatPhone(digits: string): string {
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

function ftnLookupUrl(fullName: string, city?: string, state?: string): string {
  const { first, last } = splitName(fullName);
  const params = new URLSearchParams();
  if (first) params.set("first", first);
  if (last) params.set("last", last);
  const cs = [city, state].filter(Boolean).join(", ");
  if (cs) params.set("citystatezip", cs);
  return `https://www.familytreenow.com/search/genealogy/results?${params.toString()}`;
}

interface Props {
  address: string;
  enrichment: EnrichmentState;
}

export function AddressResidentCard({ address, enrichment }: Props) {
  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 mb-3">
      <h2 className="text-sm font-semibold">Resident at this address</h2>
      <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
        via familytreenow · fallback (no person contact on Reonomy)
      </div>
      <div className="text-xs text-neutral-700 dark:text-neutral-300 mb-2 break-words">
        {address}
      </div>
      <Body enrichment={enrichment} />
    </div>
  );
}

function Body({ enrichment }: { enrichment: EnrichmentState }) {
  if (!enrichment || enrichment === "pending") {
    return (
      <div className="text-xs text-neutral-500 dark:text-neutral-400 italic">
        Looking up…
      </div>
    );
  }
  if (enrichment.status !== "ok" || !enrichment.match) {
    return (
      <div className="text-xs text-neutral-500 dark:text-neutral-400 italic">
        No FTN match{enrichment.status !== "no_match" ? ` (${enrichment.status})` : ""}.
      </div>
    );
  }
  return <Resident match={enrichment.match} />;
}

function Resident({ match }: { match: EnrichmentMatch }) {
  const heading = [match.name, typeof match.age === "number" ? String(match.age) : null]
    .filter(Boolean)
    .join(", ");
  const loc = [match.city, match.state].filter(Boolean).join(", ");
  return (
    <div>
      <div className="text-sm font-medium break-words">
        {match.profileUrl ? (
          <a
            href={match.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {heading}
          </a>
        ) : (
          heading
        )}
        {loc && (
          <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
            {loc}
          </span>
        )}
      </div>

      {match.phones && match.phones.length > 0 && (
        <Section title="Phone Numbers">
          {match.phones.map((digits, i) => {
            const tail = normalizePhone(digits).slice(-10);
            const metaText = formatPhoneMeta(
              tail ? match.phoneMeta?.[tail] : undefined
            );
            return (
              <li
                key={`p-${i}`}
                className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
              >
                <a
                  href={`tel:${digits}`}
                  className="text-accent hover:underline"
                >
                  {formatPhone(digits)}
                </a>
                {metaText && (
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {metaText}
                  </span>
                )}
              </li>
            );
          })}
        </Section>
      )}

      {match.addresses && match.addresses.length > 0 && (
        <Section title="Addresses">
          {match.addresses.map((a, i) => (
            <li
              key={`a-${i}`}
              className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words"
            >
              {a}
            </li>
          ))}
        </Section>
      )}

      {match.relatives && match.relatives.length > 0 && (
        <Section title="Relatives">
          {match.relatives.map((r, i) => {
            const { first, last } = splitName(r);
            const looksLikeName = !!(first && last);
            return (
              <li
                key={`r-${i}`}
                className="py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0 break-words flex items-center justify-between gap-2"
              >
                <span>{r}</span>
                {looksLikeName && (
                  <a
                    href={ftnLookupUrl(r, match.city, match.state)}
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
      )}
    </div>
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

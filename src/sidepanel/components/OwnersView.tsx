import type { Contact, Owner, ScrapePayload } from "../types";
import { OwnerCard } from "./OwnerCard";
import { ReportedOwnerCard } from "./ReportedOwnerCard";
import { AddressResidentCard } from "./AddressResidentCard";
import { EmptyState } from "./EmptyState";
import { contactLookupKey } from "../lib/peopleSearch";
import { ADDRESS_LOOKUP_KEY, fallbackAddress } from "../hooks/useEnrichments";
import type { EnrichmentMap } from "../hooks/useEnrichments";

interface Props {
  payload: ScrapePayload | null;
  enrichments?: EnrichmentMap;
}

function lookup(
  enrichments: EnrichmentMap | undefined,
  o: Owner | Contact
) {
  if (!enrichments) return undefined;
  const key = contactLookupKey({
    fullName: o.name,
    address: o.addresses?.[0],
  });
  return enrichments.get(key);
}

export function OwnersView({ payload, enrichments }: Props) {
  const ownership = payload?.ownership;
  const owners = ownership?.owners ?? [];
  const reported = ownership?.reported ?? null;
  const contacts = ownership?.contacts ?? [];

  if (!owners.length && !reported && !contacts.length) {
    return (
      <div>
        <EmptyState payload={payload} />
        {ownership?.rawText && (
          <details className="mt-3">
            <summary className="text-xs text-neutral-500 cursor-pointer">
              Captured ownership text (debug)
            </summary>
            <pre className="mt-2 text-[11px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded p-2 whitespace-pre-wrap break-words">
              {ownership.rawText}
            </pre>
          </details>
        )}
      </div>
    );
  }

  const addressLookup = enrichments?.get(ADDRESS_LOOKUP_KEY);
  const addressLookupAddr = addressLookup ? fallbackAddress(payload) : undefined;

  return (
    <div>
      {ownership?.source === "cached" && ownership.cachedAt && (
        <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-2">
          Cached from /ownership · {new Date(ownership.cachedAt).toLocaleString()}
        </div>
      )}
      {addressLookup && addressLookupAddr && (
        <AddressResidentCard
          address={addressLookupAddr}
          enrichment={addressLookup}
        />
      )}
      {reported && <ReportedOwnerCard reported={reported} />}
      {owners
        .filter((o) => o.kind !== "company")
        .map((o, i) => (
          <OwnerCard
            key={`owner-${o.name}-${i}`}
            owner={o}
            enrichment={lookup(enrichments, o)}
          />
        ))}
      {contacts.length > 0 && (
        <>
          <h2 className="text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mt-4 mb-2 font-semibold">
            Contacts
          </h2>
          {contacts.map((c, i) => (
            <OwnerCard
              key={`contact-${c.name}-${i}`}
              owner={c}
              enrichment={lookup(enrichments, c)}
            />
          ))}
        </>
      )}
      {owners.some((o) => o.kind === "company") && (
        <>
          <h2 className="text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mt-4 mb-2 font-semibold">
            Owning Company
          </h2>
          {owners
            .filter((o) => o.kind === "company")
            .map((o, i) => (
              <OwnerCard
                key={`company-${o.name}-${i}`}
                owner={o}
                enrichment={lookup(enrichments, o)}
              />
            ))}
        </>
      )}
    </div>
  );
}

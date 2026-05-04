import { useEffect, useRef, useState } from "react";
import type {
  Contact,
  EnrichmentResult,
  Owner,
  ScrapePayload,
} from "../types";
import {
  addressLookupKey,
  contactLookupKey,
  searchByAddress,
  searchPerson,
} from "../lib/peopleSearch";
import { getCached } from "../lib/peopleSearchCache";

export type EnrichmentMap = Map<string, EnrichmentResult | "pending">;

// Sentinel key for the address-fallback lookup. Prefixed so it can't collide
// with a contactLookupKey (which is "first|last|city|state").
export const ADDRESS_LOOKUP_KEY = "__ftn_address_lookup__";

// Address we'd pivot on when no person contact exists. Reported.address is
// the recorded mailing address for the property — for CRE that's usually an
// LLC's filing address, which often resolves to a real human's residence.
export function fallbackAddress(payload: ScrapePayload | null): string | undefined {
  if (!payload?.ownership) return undefined;
  const reported = payload.ownership.reported?.address?.trim();
  if (reported) return reported;
  for (const o of payload.ownership.owners ?? []) {
    const a = o.addresses?.[0]?.trim();
    if (a) return a;
  }
  return undefined;
}

// Hidden-tab fetches are heavy (each opens a real tab). Keep concurrency at
// 1 so the user only ever sees one inactive tab at a time. Stagger is short
// since each enrichment already does its own search→detail wait internally.
const CONCURRENCY = 1;
const STAGGER_MS = 200;

interface Target {
  key: string;
  fullName: string;
  address?: string;
}

function collectTargets(payload: ScrapePayload | null): Target[] {
  if (!payload?.ownership) return [];
  const targets: Target[] = [];
  const seen = new Set<string>();
  const push = (o: Owner | Contact) => {
    if (!o.name) return;
    const fullName = o.name;
    const address = o.addresses?.[0];
    const key = contactLookupKey({ fullName, address });
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ key, fullName, address });
  };
  for (const o of payload.ownership.owners ?? []) {
    if (o.kind === "company") continue;
    push(o);
  }
  for (const c of payload.ownership.contacts ?? []) {
    push(c);
  }
  return targets;
}

// Probe the cache to see if every enrichment target for this property is
// already a successful cache hit. App.tsx uses this to skip the manual
// "Find contacts" button when re-visiting a property whose lookups have
// already run — cache hits don't fetch, so re-enriching is free.
export async function allTargetsCached(
  payload: ScrapePayload | null
): Promise<boolean> {
  if (!payload) return false;
  const targets = collectTargets(payload);
  if (targets.length > 0) {
    for (const t of targets) {
      const cached = await getCached(t.key);
      if (!cached) return false;
    }
    return true;
  }
  const addr = fallbackAddress(payload);
  if (!addr) return false;
  const cached = await getCached(addressLookupKey(addr));
  return !!cached;
}

export function useEnrichments(
  payload: ScrapePayload | null,
  enabled: boolean
): EnrichmentMap {
  const [map, setMap] = useState<EnrichmentMap>(() => new Map());
  // Synchronous in-flight set — setMap("pending") is async, so without this
  // multiple effect runs landing in the same tick all see undefined and
  // re-dispatch the same fetch. That blast of duplicate hits is what trips
  // TPS's bot detection.
  const startedRef = useRef<Set<string>>(new Set());
  const unmountedRef = useRef(false);
  const queueRef = useRef<Target[]>([]);
  const inFlightRef = useRef(0);
  // Session token bumped on every property URL change so in-flight fetches
  // from the previous property don't write stale results back into the map
  // after we've reset it.
  const sessionRef = useRef(0);
  const lastUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Reset all enrichment state when navigating to a different property.
  // Otherwise stale entries (the address-fallback card in particular) bleed
  // across properties because the map and startedRef persist across re-runs.
  useEffect(() => {
    if (payload?.url === lastUrlRef.current) return;
    lastUrlRef.current = payload?.url;
    sessionRef.current++;
    startedRef.current = new Set();
    queueRef.current = [];
    inFlightRef.current = 0;
    setMap(new Map());
  }, [payload?.url]);

  useEffect(() => {
    if (!enabled) return;
    const targets = collectTargets(payload);
    if (targets.length === 0) return;

    const fresh = targets.filter((t) => !startedRef.current.has(t.key));
    if (fresh.length === 0) return;

    console.info(
      `[useEnrichments] queueing ${fresh.length} contact(s) for lookup`,
      fresh.map((t) => t.fullName)
    );

    for (const t of fresh) startedRef.current.add(t.key);

    setMap((prev) => {
      const next = new Map(prev);
      for (const t of fresh) {
        if (!next.has(t.key)) next.set(t.key, "pending");
      }
      return next;
    });

    queueRef.current.push(...fresh);

    const session = sessionRef.current;
    const pump = () => {
      while (
        inFlightRef.current < CONCURRENCY &&
        queueRef.current.length > 0
      ) {
        const target = queueRef.current.shift()!;
        inFlightRef.current++;
        setTimeout(() => {
          searchPerson({ fullName: target.fullName, address: target.address })
            .then((result) => {
              if (unmountedRef.current) return;
              if (sessionRef.current !== session) return;
              setMap((prev) => {
                const next = new Map(prev);
                next.set(target.key, result);
                return next;
              });
            })
            .catch((err) => {
              if (unmountedRef.current) return;
              if (sessionRef.current !== session) return;
              console.error(
                "[useEnrichments] searchPerson threw for",
                target.fullName,
                err
              );
              setMap((prev) => {
                const next = new Map(prev);
                next.set(target.key, {
                  source: "truepeoplesearch",
                  status: "error",
                  fetchedAt: new Date().toISOString(),
                });
                return next;
              });
            })
            .finally(() => {
              inFlightRef.current--;
              pump();
            });
        }, STAGGER_MS);
      }
    };
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.url, payload?.scrapedAt, enabled]);

  // Address fallback: if there are no person contacts to enrich (typical of
  // LLC-owned CRE), pivot on the property's recorded mailing address and let
  // FTN's reverse-address search surface a likely human resident.
  useEffect(() => {
    if (!enabled) return;
    if (!payload?.ownership) return;
    if (collectTargets(payload).length > 0) return;
    const addr = fallbackAddress(payload);
    if (!addr) return;
    if (startedRef.current.has(ADDRESS_LOOKUP_KEY)) return;
    startedRef.current.add(ADDRESS_LOOKUP_KEY);

    console.info(`[useEnrichments] no person targets — address lookup ${addr}`);

    setMap((prev) => {
      const next = new Map(prev);
      next.set(ADDRESS_LOOKUP_KEY, "pending");
      return next;
    });

    const session = sessionRef.current;
    searchByAddress(addr)
      .then((result) => {
        if (unmountedRef.current) return;
        if (sessionRef.current !== session) return;
        setMap((prev) => {
          const next = new Map(prev);
          next.set(ADDRESS_LOOKUP_KEY, result);
          return next;
        });
      })
      .catch((err) => {
        if (unmountedRef.current) return;
        if (sessionRef.current !== session) return;
        console.error("[useEnrichments] searchByAddress threw", err);
        setMap((prev) => {
          const next = new Map(prev);
          next.set(ADDRESS_LOOKUP_KEY, {
            source: "familytreenow",
            status: "error",
            fetchedAt: new Date().toISOString(),
          });
          return next;
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.url, payload?.scrapedAt, enabled]);

  return map;
}

export interface Phone {
  number: string;
  type: string;
  entity?: string;
}

export interface Owner {
  name: string;
  kind?: "company" | "person";
  parentCompany?: string;
  title?: string;
  profileUrl?: string;
  phones: Phone[];
  emails: string[];
  addresses: string[];
}

export interface Contact {
  name: string;
  role?: string;
  title?: string;
  profileUrl?: string;
  phones: Phone[];
  emails: string[];
  addresses: string[];
}

export interface ReportedOwner {
  names: string[];
  address: string;
}

export interface Ownership {
  owners: Owner[];
  reported: ReportedOwner | null;
  contacts?: Contact[];
  rawText?: string;
  source?: string;
  cachedAt?: string;
  cachedUrl?: string;
}

export interface PropertyInfo {
  propertyId: string;
  section: string;
}

export interface KvPair {
  label: string;
  value: string;
}

export interface PhoneMeta {
  /** "Landline" / "Wireless" / similar */
  type?: string;
  /** Verbatim "Last reported MMM YYYY" string from the source. */
  lastReported?: string;
  /** Carrier name e.g. "Ameritech Indiana" / "Verizon Wireless". */
  carrier?: string;
}

export interface EnrichmentMatch {
  name: string;
  age?: number;
  city?: string;
  state?: string;
  relatives?: string[];
  addresses?: string[];
  /** TPS detail-page URL (relative or absolute). Set when we have a profile id. */
  profileUrl?: string;
  /** Phone numbers from the TPS detail page, normalized to digits-only. */
  phones?: string[];
  /**
   * Per-phone metadata (type / last-reported date / carrier) keyed by the
   * last 10 digits of the number. Currently populated by FTN; TPS may
   * contribute later.
   */
  phoneMeta?: Record<string, PhoneMeta>;
  /** Email addresses from the TPS detail page, lowercased. */
  emails?: string[];
}

export type EnrichmentStatus = "ok" | "no_match" | "blocked" | "error";

export type EnrichmentSource = "truepeoplesearch" | "familytreenow";

export interface EnrichmentResult {
  source: EnrichmentSource;
  status: EnrichmentStatus;
  match?: EnrichmentMatch;
  /**
   * Per-adapter matches kept around after merge so the UI can attribute
   * corroboration ("found in tps + ftn") rather than only seeing the
   * already-merged blob. Absent for non-ok results.
   */
  bySource?: Partial<Record<EnrichmentSource, EnrichmentMatch>>;
  fetchedAt: string;
}

export interface ScrapePayload {
  url: string;
  scrapedAt: string;
  property: PropertyInfo | null;
  ownership: Ownership;
  headline: string;
  description: string;
  meta: Record<string, string>;
  jsonLd: unknown[];
  headings: { title: string; h1: string[]; h2: string[] };
  definitionLists: KvPair[][];
  tables: Array<{ kv: KvPair[]; matrix: string[][] }>;
  labeledPairs: KvPair[];
  error?: string;
}

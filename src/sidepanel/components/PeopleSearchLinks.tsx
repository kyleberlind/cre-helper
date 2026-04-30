import { parseLocation, splitName } from "../lib/peopleSearch";

interface Props {
  fullName: string;
  addresses?: string[];
}

interface Query {
  first: string;
  last: string;
  city: string;
  state: string;
  full: string;
}

interface Site {
  name: string;
  build: (q: Query) => string;
}

const SITES: Site[] = [
  {
    name: "FamilyTreeNow",
    build: ({ first, last, city, state }) => {
      const params = new URLSearchParams();
      if (first) params.set("first", first);
      if (last) params.set("last", last);
      const cs = [city, state].filter(Boolean).join(", ");
      if (cs) params.set("citystatezip", cs);
      return `https://www.familytreenow.com/search/genealogy/results?${params.toString()}`;
    },
  },
  {
    name: "TruePeopleSearch",
    build: ({ first, last, city, state }) => {
      const params = new URLSearchParams();
      const name = [first, last].filter(Boolean).join(" ");
      if (name) params.set("name", name);
      const cs = [city, state].filter(Boolean).join(", ");
      if (cs) params.set("citystatezip", cs);
      return `https://www.truepeoplesearch.com/results?${params.toString()}`;
    },
  },
  {
    name: "Google",
    build: ({ full, city, state }) => {
      const q = [`"${full}"`, city, state].filter(Boolean).join(" ");
      return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    },
  },
];

export function PeopleSearchLinks({ fullName, addresses }: Props) {
  if (!fullName) return null;
  const { first, last } = splitName(fullName);
  const { city, state } = parseLocation(addresses?.[0] ?? "");
  const query: Query = { first, last, city, state, full: fullName };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 font-semibold">
        Look up
      </span>
      {SITES.map((site) => (
        <a
          key={site.name}
          href={site.build(query)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent hover:underline"
        >
          {site.name}
        </a>
      ))}
    </div>
  );
}

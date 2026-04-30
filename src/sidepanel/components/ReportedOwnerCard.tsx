import type { ReportedOwner } from "../types";

interface Props {
  reported: ReportedOwner;
}

export function ReportedOwnerCard({ reported }: Props) {
  if (!reported.names.length && !reported.address) return null;
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-3 mb-3">
      <h2 className="text-sm font-semibold mb-2">Reported Owner</h2>

      {reported.names.length > 0 && (
        <Row label="Name(s)" value={reported.names.join(" · ")} />
      )}
      {reported.address && (
        <Row label="Mailing address" value={reported.address} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-xs py-1 border-b border-dashed border-neutral-200 dark:border-neutral-700 last:border-b-0">
      <div className="text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="break-words">{value}</div>
    </div>
  );
}

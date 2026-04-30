import type { ScrapePayload } from "../types";

interface Props {
  payload: ScrapePayload | null;
}

export function EmptyState({ payload }: Props) {
  const propertyId = payload?.property?.propertyId;
  const ownershipUrl = propertyId
    ? `https://app.reonomy.com/!/property/${propertyId}/ownership`
    : null;

  return (
    <div className="text-neutral-500 dark:text-neutral-400 italic text-xs p-2 leading-relaxed">
      {ownershipUrl ? (
        <>
          No owner data cached for this property yet.{" "}
          <a
            href={ownershipUrl}
            target="_top"
            className="text-accent not-italic hover:underline"
          >
            Open the Ownership tab
          </a>{" "}
          once and it'll appear here on every sub-tab of this property.
        </>
      ) : (
        "Open a property page to see owner data."
      )}
    </div>
  );
}

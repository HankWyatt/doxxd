import type { ReactNode } from "react";

/**
 * An unknown value: nothing visible, "Unknown" for screen readers, and the
 * reason (when the code knows it) as a hover title. Unknown is never $0.
 */
export function UnknownValue({ reason }: { reason?: string }) {
  return (
    <span title={reason ?? "Not available"}>
      <span className="sr-only">Unknown</span>
    </span>
  );
}

/** Shows a formatted value, or the blank unknown marker when the formatter had none. */
export function orUnknown(text: string | null, reason?: string): ReactNode {
  return text === null ? <UnknownValue reason={reason} /> : text;
}

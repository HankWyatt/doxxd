"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
export function CopyButton({
  value,
  label = "Copy address",
}: {
  value: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={state === "copied" ? "Copied" : label}
        title={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span className="sr-only" role="status">
        {state === "copied"
          ? "Copied to clipboard"
          : state === "failed"
            ? "Could not copy. Select the full address below."
            : ""}
      </span>
    </>
  );
}

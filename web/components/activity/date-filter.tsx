"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { WalletDataMode } from "@/lib/dmnd/contracts";
import {
  activityHref,
  parseActivityWindow,
  type ActivityWindow,
} from "@/lib/activity/window";
export function DateFilter({
  address,
  window,
  mode,
  source,
}: {
  address: string;
  window: ActivityWindow;
  mode: WalletDataMode;
  source: "transactions" | "activity";
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [from, setFrom] = useState(
    window.from ? new Date(window.from).toISOString().slice(0, 19) : "",
  );
  const [to, setTo] = useState(
    window.to ? new Date(window.to).toISOString().slice(0, 19) : "",
  );
  const [error, setError] = useState(false);
  const router = useRouter();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        if (from)
          params.set("from", from + (from.length === 16 ? ":00Z" : "Z"));
        if (to) params.set("to", to + (to.length === 16 ? ":00Z" : "Z"));
        const next = parseActivityWindow(params);
        if (next === null) {
          setError(true);
          return;
        }
        setError(false);
        router.push(activityHref(address, next, undefined, mode, source));
      }}
    >
      <div className="date-filter">
        <label>
          From (UTC)
          <input
            disabled={!ready}
            aria-label="From (UTC)"
            type="datetime-local"
            step="1"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To (UTC)
          <input
            disabled={!ready}
            aria-label="To (UTC)"
            type="datetime-local"
            step="1"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="button" type="submit" disabled={!ready}>
          Apply
        </button>
        {(window.from || window.to) && (
          <button
            disabled={!ready}
            type="button"
            className="button ghost"
            onClick={() =>
              router.push(activityHref(address, {}, undefined, mode, source))
            }
          >
            Clear
          </button>
        )}
      </div>
      {error && (
        <p className="search-error" role="alert">
          Choose a valid UTC range with From before To.
        </p>
      )}
    </form>
  );
}

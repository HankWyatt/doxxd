"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";
import { normalizeAddress, walletHref } from "@/lib/address";
export function AddressSearch({
  initialAddress = "",
}: {
  initialAddress?: string;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [input, setInput] = useState(initialAddress);
  const [error, setError] = useState(false);
  const router = useRouter();
  const errorId = useId();
  return (
    <form
      className="search-form"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const address = normalizeAddress(input);
        setError(!address);
        if (address) router.push(walletHref(address, "portfolio"));
      }}
    >
      <div className="search-box">
        <Search size={17} />
        <input
          disabled={!ready}
          aria-label="Solana address"
          aria-invalid={error}
          aria-describedby={error ? errorId : undefined}
          placeholder="Paste a Solana wallet address…"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(false);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button disabled={!ready} type="submit" aria-label="Explore wallet">
          <span className="search-label">Explore wallet</span>
          <ArrowRight size={16} />
        </button>
      </div>
      {error && (
        <p className="search-error" id={errorId} role="alert">
          Enter a valid Solana address.
        </p>
      )}
    </form>
  );
}

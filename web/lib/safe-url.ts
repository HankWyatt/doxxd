export function tokenImageUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    const native = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(.*)$/i.exec(input.trim());
    const url = new URL(native ? "https://ipfs.io/ipfs/" + native[1] + native[2] : input);
    if (native) {
      const root = "/ipfs/" + native[1];
      if (!isIpfsCid(native[1]) ||
        !(url.pathname === root || url.pathname.startsWith(root + "/"))) return null;
    }
    const host = url.hostname.replace(/\.$/, "");
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      // Token publishers use many CDNs. Accept public DNS names instead of
      // silently discarding images outside a small, hardcoded provider list.
      host.includes(".") &&
      !/^[\d.]+$/.test(host) &&
      !host.includes(":") &&
      !/(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function isIpfsCid(cid: string): boolean {
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(cid);
}
function ipfsPath(url: URL): string | null {
  const path = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const subdomain = /^([^.]+)\.ipfs\./.exec(url.hostname);
  const cid = subdomain?.[1] ?? path?.[1];
  if (!cid || !isIpfsCid(cid)) return null;
  return "/ipfs/" + cid + (subdomain ? url.pathname : path?.[2] ?? "");
}

export function tokenImageCandidates(input: unknown): string[] {
  const primary = tokenImageUrl(input);
  if (!primary) return [];
  const path = ipfsPath(new URL(primary));
  // Prefer a gateway that served real token images reliably; keep a bounded
  // fallback set for the same immutable content.
  // Gateway-specific query tokens stay on the original host.
  return [...new Set(path
    ? ["https://gateway.pinata.cloud" + path, primary, "https://ipfs.io" + path, "https://dweb.link" + path]
    : [primary])];
}
/** Solscan page for a wallet or account, a token mint, or a transaction. */
export function explorerHref(kind: "account" | "token" | "tx", value: string): string {
  return "https://solscan.io/" + kind + "/" + encodeURIComponent(value);
}

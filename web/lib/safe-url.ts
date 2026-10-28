export function tokenImageUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["arweave.net", "ipfs.io", "raw.githubusercontent.com"].includes(
        url.hostname,
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function explorerHref(kind: "address" | "tx", value: string): string {
  return (
    "https://explorer.solana.com/" + kind + "/" + encodeURIComponent(value)
  );
}

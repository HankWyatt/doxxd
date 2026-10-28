import { expect, it } from "vitest";
import { tokenImageUrl, explorerHref } from "./safe-url";
it("restricts images to credential-free HTTPS approved hosts", () => {
  expect(tokenImageUrl("https://arweave.net/token.png")).toBe(
    "https://arweave.net/token.png",
  );
  for (const value of [
    "javascript:alert(1)",
    "http://arweave.net/a",
    "https://user:secret@arweave.net/a",
    "https://arweave.net.evil.test/a",
  ])
    expect(tokenImageUrl(value)).toBeNull();
  expect(explorerHref("address", "a/b")).toBe(
    "https://explorer.solana.com/address/a%2Fb",
  );
});

import { expect, it } from "vitest";
import { tokenImageUrl, tokenImageCandidates, explorerHref } from "./safe-url";
const cid = "QmbLnVVK29LbUNic4XMeMKb1f8kACbKYfzTVfZAxFgN4s5";
it("accepts public HTTPS image providers instead of restricting tokens to three hosts", () => {
  for (const value of [
    "https://arweave.net/token.png",
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/token.png",
    "https://cdn.backpack.exchange/token.png",
    "https://gateway.irys.xyz/token",
    "https://tokens.example.com/icon.png?v=2",
  ]) expect(tokenImageUrl(value)).toBe(value);
});

it("normalizes native IPFS images to HTTPS while preserving CID case and paths", () => {
  expect(tokenImageUrl(`ipfs://${cid}/token.png`)).toBe(`https://ipfs.io/ipfs/${cid}/token.png`);
  expect(tokenImageUrl(`ipfs://ipfs/${cid}/folder/token image.png`)).toBe(`https://ipfs.io/ipfs/${cid}/folder/token%20image.png`);
  expect(tokenImageUrl("ipfs://not-a-cid/token.png")).toBeNull();
  expect(tokenImageUrl(`ipfs://user:secret@${cid}/token.png`)).toBeNull();
});

it.each(["..", "%2e%2e"])("refuses native IPFS paths that escape their root CID via %s", (segment) => {
  const other = "bafybeiahse4pe2djpf2u3mkmic65s2x6cnahzlqwzv5jbk3o3rytwrkigi";
  expect(tokenImageUrl(`ipfs://${cid}/${segment}/${other}/token.png`)).toBeNull();
  expect(tokenImageCandidates(`ipfs://${cid}/${segment}/${other}/token.png`)).toEqual([]);
  expect(tokenImageUrl(`ipfs://${cid}/folder/${segment}/token.png`)).toBe(`https://ipfs.io/ipfs/${cid}/token.png`);
});

it("bounds gateway fallback to the same IPFS content without forwarding query tokens", () => {
  expect(tokenImageCandidates(`https://publisher.example.com/ipfs/${cid}/token.png?gatewayToken=private`)).toEqual([
    `https://gateway.pinata.cloud/ipfs/${cid}/token.png`,
    `https://publisher.example.com/ipfs/${cid}/token.png?gatewayToken=private`,
    `https://ipfs.io/ipfs/${cid}/token.png`,
    `https://dweb.link/ipfs/${cid}/token.png`,
  ]);
  expect(tokenImageCandidates(`ipfs://${cid}/token.png`)).toEqual([
    `https://gateway.pinata.cloud/ipfs/${cid}/token.png`,
    `https://ipfs.io/ipfs/${cid}/token.png`, `https://dweb.link/ipfs/${cid}/token.png`,
  ]);
  expect(tokenImageCandidates("https://tokens.example.com/icon.png")).toEqual(["https://tokens.example.com/icon.png"]);
  expect(tokenImageCandidates(null)).toEqual([]);
  expect(tokenImageCandidates(`http://localhost/ipfs/${cid}/token.png`)).toEqual([]);
});

it("supports CIDv1 IPFS subdomain gateways", () => {
  const v1 = "bafybeiahse4pe2djpf2u3mkmic65s2x6cnahzlqwzv5jbk3o3rytwrkigi";
  expect(tokenImageCandidates(`https://${v1}.ipfs.publisher.example.com/token.png`)).toEqual([
    `https://gateway.pinata.cloud/ipfs/${v1}/token.png`,
    `https://${v1}.ipfs.publisher.example.com/token.png`,
    `https://ipfs.io/ipfs/${v1}/token.png`, `https://dweb.link/ipfs/${v1}/token.png`,
  ]);
  expect(tokenImageCandidates(`https://${v1}.ipfs.publisher.example.com/ipfs/${cid}/token.png`)).toEqual([
    `https://gateway.pinata.cloud/ipfs/${v1}/ipfs/${cid}/token.png`,
    `https://${v1}.ipfs.publisher.example.com/ipfs/${cid}/token.png`,
    `https://ipfs.io/ipfs/${v1}/ipfs/${cid}/token.png`,
    `https://dweb.link/ipfs/${v1}/ipfs/${cid}/token.png`,
  ]);
});
it("rejects non-HTTPS, credentialed, local and literal-address image URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "http://arweave.net/a",
    "https://user:secret@arweave.net/a",
    "https://localhost/a", "https://localhost./a", "https://api.localhost/a",
    "https://127.0.0.1/a", "https://10.0.0.1/a", "https://[::1]/a",
    "https://2130706433/a", "https://0x7f000001/a",
    "https://router.local/a", "https://server.internal/a", "https://singlelabel/a",
    "https://tokens.example.com:8443/a", "/icon.png", null, {},
  ])
    expect(tokenImageUrl(value)).toBeNull();
  expect(explorerHref("account", "a/b")).toBe("https://solscan.io/account/a%2Fb");
  expect(explorerHref("token", "So11111111111111111111111111111111111111112")).toBe(
    "https://solscan.io/token/So11111111111111111111111111111111111111112",
  );
  expect(explorerHref("tx", "sig/1")).toBe("https://solscan.io/tx/sig%2F1");
});

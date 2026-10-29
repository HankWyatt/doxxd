import "./buffer-polyfill";
import { Connection } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { ClmmInstrument } from "@raydium-io/raydium-sdk-v2";

// Placeholder until the builders land. Using each SDK keeps it in this chunk
// so the build proves the chunk and Worker-stub behavior. Replaced in Task 8.
export function sdkProbe(): string[] {
  const cpAmm = new CpAmm(new Connection("http://127.0.0.1:1"));
  return [typeof cpAmm.claimPositionFee2, typeof ClmmInstrument];
}

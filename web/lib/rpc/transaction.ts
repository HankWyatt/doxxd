// A minimal, pure reader for the transactions /api/rpc forwards
// (sendTransaction, simulateTransaction): just enough of the wire format to
// name every top-level program. No web3.js, so the Worker bundle stays free
// of the Solana SDKs (ruling R-P4).
//
// Wire format (Solana transaction, legacy and v0):
//   compact-u16 signature count, then 64 bytes per signature;
//   message: [0x80 | version] for a versioned message (only v0), the header
//   (3 bytes), compact-u16 key count and 32 bytes per key, the 32-byte recent
//   blockhash, compact-u16 instruction count, and per instruction its
//   program-id index (u8), compact-u16 account count and one u8 index each,
//   compact-u16 data length and the data; a v0 message then has a
//   compact-u16 count of address-table lookups.
import bs58 from "bs58";

export type ParsedTransaction = {
  /** Top-level program ids, base58, in instruction order. */
  programs: string[];
  /** Address-table lookups (v0 only; always 0 for legacy). */
  lookups: number;
};

class Malformed extends Error {}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Parses a base64 transaction; null when it is not exactly one well-formed transaction. */
export function parseTransaction(base64: string): ParsedTransaction | null {
  const bytes = decodeBase64(base64);
  if (!bytes) return null;
  let at = 0;
  const byte = (): number => {
    if (at >= bytes.length) throw new Malformed();
    return bytes[at++];
  };
  const skip = (n: number) => {
    if (n < 0 || at + n > bytes.length) throw new Malformed();
    at += n;
  };
  // compact-u16: up to 3 bytes, 7 bits each, little-endian.
  const compactU16 = (): number => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (value > 0xffff) throw new Malformed();
        return value;
      }
    }
    throw new Malformed();
  };
  try {
    skip(compactU16() * 64);
    let versioned = false;
    if (bytes[at] !== undefined && bytes[at] & 0x80) {
      if ((byte() & 0x7f) !== 0) return null; // only v0
      versioned = true;
    }
    skip(3); // header
    const keyCount = compactU16();
    const keysAt = at;
    skip(keyCount * 32);
    skip(32); // recent blockhash
    const programs: string[] = [];
    const instructions = compactU16();
    for (let i = 0; i < instructions; i++) {
      const programIndex = byte();
      if (programIndex >= keyCount) return null;
      const start = keysAt + programIndex * 32;
      programs.push(bs58.encode(bytes.subarray(start, start + 32)));
      skip(compactU16()); // account indexes, one byte each
      skip(compactU16()); // data
    }
    const lookups = versioned ? compactU16() : 0;
    // Lookups are refused anyway, so their bodies are not read; but without
    // any, the message must end exactly here.
    if (lookups === 0 && at !== bytes.length) return null;
    return { programs, lookups };
  } catch (error) {
    if (error instanceof Malformed) return null;
    throw error;
  }
}

/**
 * True when `base64` is one well-formed legacy or v0 transaction with no
 * address-table lookups whose top-level programs are all in `allowed`.
 */
export function transactionAllowed(base64: string, allowed: readonly string[]): boolean {
  const parsed = parseTransaction(base64);
  return parsed !== null && parsed.lookups === 0 && parsed.programs.every((p) => allowed.includes(p));
}

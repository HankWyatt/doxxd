import { Buffer } from "buffer";

// The Raydium SDK uses a bare global `Buffer` at module scope. Browsers have
// none; this runs first in the lazy chunk (see ./index.ts).
globalThis.Buffer ??= Buffer;

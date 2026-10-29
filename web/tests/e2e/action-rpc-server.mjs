// E2E helper, started by playwright.config.ts: answers Solana JSON-RPC from
// the synthetic chain (tests/fixtures/actions-chain.ts) on 127.0.0.1:4319.
// lp-actions specs forward the page's /api/rpc requests here.
//
// The fixtures load through Vite's module runner in this plain Node process,
// like Vitest runs them; Playwright's own loader cannot load the Solana SDKs.
//   GET  /health   200 once ready
//   GET  /fixture  the chain's addresses and amounts (ChainSummary)
//   POST /rpc      one JSON-RPC request, answered through the /api/rpc policy
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const PORT = 4319;
const root = fileURLToPath(new URL("../..", import.meta.url));

// Same notice Vitest drops (vitest.config.ts): installs skip native builds.
const warn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("bigint: Failed to load bindings")) return;
  warn(...args);
};

const { module } = await runnerImport("/tests/e2e/action-rpc-chain.ts", {
  configFile: false,
  root,
  logLevel: "error",
  resolve: { alias: { "@": root } },
});
const chain = module.createActionChain();

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/fixture") return json(res, 200, chain.summary);
  if (req.method === "POST" && req.url === "/rpc") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      try {
        const answer = chain.answer(body);
        json(res, answer.status, answer.body);
      } catch {
        json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      }
    });
    return;
  }
  json(res, 404, { ok: false });
}).listen(PORT, "127.0.0.1");

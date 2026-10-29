# Doxxd

Look up any public Solana wallet and see its holdings, staking, lending, liquidity and trading positions and activity, powered by the [DMND](https://dmnd.dev) API.

[![CI](https://github.com/HankWyatt/doxxd/actions/workflows/ci.yml/badge.svg)](https://github.com/HankWyatt/doxxd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Doxxd wallet page rendered from synthetic test fixtures](docs/screenshot.png)

The screenshot shows the wallet page rendered from synthetic test fixtures, not a real wallet.

## Features

- **No sign-up.** Paste a public address. No wallet connection or account is required.
- **Portfolio.** The headline is DMND's authoritative known net value. The holdings list shows the top 10 priced tokens, with unpriced and tiny balances collapsed into one line; it is searchable by name, symbol or mint, and shows indexed buy/sell totals and P&L estimates where DMND has trading history. Expandable protocol views cover native staking, liquid staking, Kamino, Solend, MarginFi, Orca, Raydium, Meteora DLMM, Meteora DAMM v2, Drift and Velocity.
- **Activity.** Observed executions, transfers, fees and net changes, with UTC date filters and opaque cursor pages kept in the URL.
- **Watchlist.** Save addresses and optional labels in your browser. The list makes no wallet data requests.
- **Server-only gateway.** DMND credentials never reach the browser. The browser calls same-origin `/api/wallet/...` routes, and a data error never substitutes synthetic values.

## Quick start

Use Node 22.13 or newer. From the repository root:

```sh
cd web
npm run install:ci
npm run dev -- --host 127.0.0.1 --port 4317
```

Visit `http://127.0.0.1:4317/` and enter a Solana address. There is no public demo or sample-data route; synthetic fixtures are used only by the automated tests.

Wallet routes are `/wallet/<address>` and `/wallet/<address>/activity`. They need a DMND API key (see below). Without one they show a connection state, never synthetic data.

## Configuration

Live data comes from the [DMND API](https://docs.dmnd.dev) through a server-side gateway. Get an API key at [dmnd.dev](https://dmnd.dev). Set these environment names when starting the server; the same names are documented in [`web/.env.example`](web/.env.example). Never expose credentials with a `NEXT_PUBLIC_` prefix, and keep local secrets out of Git.

| Name | Purpose |
| --- | --- |
| `DMND_API_BASE_URL` | DMND API root; default `https://api.dmnd.dev/api/v1`. HTTPS is required except for loopback in development. |
| `DMND_API_KEY` | Server-only credential. Missing or invalid configuration displays a connection state. |
| `DMND_ENABLED_PROTOCOLS` | Comma-separated **resource IDs** qualified by DMND for serving. Default empty. |
| `DMND_ALLOWED_WALLETS` | Optional server allowlist of wallet addresses; omit for public arbitrary-wallet use. |
| `DMND_REQUEST_BUDGET` | Optional per-runtime upstream request cap, integer 1-34. Omit for normal public operation. |
| `DOXXD_ACTIONS_ENABLED` | Server-only switch for [on-site actions](#on-site-actions). Off unless exactly `1` and `SOLANA_RPC_URL` is set. |
| `SOLANA_RPC_URL` | Server-only secret, required for on-site actions: your Solana RPC provider's mainnet URL behind `/api/rpc`. There is no default, because the public `api.mainnet-beta.solana.com` refuses requests from Cloudflare Workers. It usually carries a key and never reaches the browser. |

Protocol IDs: `stake`, `liquid-staking`, `kamino`, `solend`, `marginfi`, `orca`, `raydium-clmm`, `meteora`, `meteora-damm-v2`, `raydium-cpmm`, `raydium-amm-v4`, `raydium-farms`, `drift`, `velocity`. These are supported consumer views, not a claim that every upstream protocol is currently activated. Summary, overview, indexed trading positions and activity use fixed routes independently.

The gateway accepts only known resources and validated filters, rejects redirects and mismatched wallets or summary component sources, times out requests, and returns safe errors. Known summary components must identify the correct wallet, resource and protocol; future components retain canonical wallet-scoped provenance and the service's authoritative total. Protocol cards for sources with a value in the summary, or a receipt in the holdings, load when the page loads; the rest stay collapsed under "Not checked yet" and load only when opened. Requests are limited to four at a time.

Token images load lazily from credential-free HTTPS URLs on DNS hostnames, with no page referrer. Native IPFS image URIs resolve through HTTPS, and IPFS images can retry the same CID and path through a bounded set of public gateways. Literal IPs, local hostnames and custom ports are refused; missing or failed images fall back to initials. Native SOL uses a local vector icon. Images are loaded by the browser, never through a server proxy.

Portfolio resources recheck queued or running scans and temporary request failures automatically, every five seconds after a response and respecting `Retry-After`. Checks stop when the data is ready, after twenty retries, or after two minutes; a hidden tab pauses them without extending that window. Loaded values stay visible if a refresh fails, and a status notice explains automatic checks, retained data and the manual **Check again** fallback. This applies to the overview, the summary and the first page of expanded protocol views; activity history and continuation pages keep manual refresh. Partial coverage, missing prices and disabled protocols do not start polling.

## On-site actions

When the server enables them, a visitor can connect their own Solana wallet on their own wallet page and **claim fees** or **withdraw** from Meteora DAMM v2 and Raydium CLMM, CPMM and AMM v4 positions: one position, a selection, or "Claim all fees" on a card. CPMM and AMM v4 fees are part of the LP tokens, so those rows offer only Withdraw. Viewing someone else's wallet never shows action buttons.

**Doxxd never holds keys.** Transactions are built in the browser from live chain state and signed only by the visitor's wallet, through the Wallet Standard. Doxxd never signs, stores or sees a key and charges no fee. Card and table values still come from DMND; dialogs and progress show live quotes and simulation results.

- **Off switch.** Everything is off unless the server sets `DOXXD_ACTIONS_ENABLED=1` and an RPC provider URL in `SOLANA_RPC_URL`. If either is missing, there is no Connect wallet button and no action UI, no wallet or protocol SDK code loads, and `/api/rpc` returns 404 for every method.
- **RPC pass-through.** The browser reads chain state through the same-origin `/api/rpc` route, which forwards to `SOLANA_RPC_URL`. It is not a general RPC proxy. It accepts one JSON-RPC request at a time, only the methods the builders need (account and program-account reads, blockhash, block height, slot, epoch, rent, priority fees, simulate, send and signature statuses), each in the exact shapes the client uses within size limits. A transaction to simulate or send must parse, use no lookup tables and call only the programs the pre-sign check allows. Requests go upstream with the pass-through's own request id and never follow a redirect. The upstream URL, its errors and any key never reach a response. Each runtime rate-limits per client (an IPv6 client per /64): 300 calls a minute, of which at most 40 sends.
- **Deploying with actions on.** The per-runtime limits are not global, so a production deploy also needs a Cloudflare rate-limiting rule on `/api/rpc` (per client IP, for example a few hundred requests a minute). Keep `SOLANA_RPC_URL` a secret, not a plain variable.
- **Pre-sign check.** Before the wallet sees a transaction, and again after it signs, Doxxd checks the message and refuses anything that could do more than the action chosen:
  - every account is listed in the message (no lookup tables);
  - the connected wallet pays the fee and is the only signer;
  - only the LP programs, the token programs, the associated-token program and compute budget are called directly; the System and Memo programs never are (they appear only as accounts that creating a token account or a Raydium instruction needs);
  - compute limit and priority fee are capped;
  - new token accounts are only the wallet's own, for the tokens it should receive, and only those may be closed, back to the wallet;
  - protocol instructions come from a fixed list, with their payout accounts and position NFTs checked;
  - a claim only collects fees and rewards;
  - a withdrawal removes exactly what the visitor chose: from the chosen pool (and, for CPMM and AMM v4, the chosen LP token account), the exact liquidity or LP amount the dialog quoted, with the dialog's minimum amounts, at most once per position. A position is closed only when the dialog said it would be.
- **Then simulate, sign, send.** Each transaction is simulated, and a claim with nothing to collect is skipped. The wallet is asked to sign in prompts of up to 10. Only the exact bytes that were checked are sent, and a transaction the wallet changed is not sent. Stopping or declining leaves the rest unclaimed; nothing is lost. Confirmed rows read "Just claimed · updating" or "Withdrawn · updating" until DMND catches up.

## Scripts

Run these from `web/`.

| Command | What it does |
| --- | --- |
| `npm run install:ci` | Clean install from the lockfile |
| `npm run dev` | Start the Vinext development server |
| `npm run build` | Build the Worker bundle |
| `npm start` | Preview the built Worker locally through Wrangler; it does not deploy |
| `npm test` | Unit and component tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run test:e2e` | Browser tests (Playwright Chromium) against an isolated synthetic server |
| `npm run contracts:generate` | Regenerate API types and validation schemas from the pinned contract |
| `npm run lint` | ESLint; it currently reports existing issues and is not part of CI |

After `npm run build`, `DOXXD_E2E_BUILT=1 npm run test:e2e` runs the browser tests against the compiled Worker instead of the development server. The browser tests serve the app on port 4318 and a synthetic Solana RPC helper for the wallet-action flows on port 4319.

`web/scripts/` also holds staged live-verification tooling (`acceptance:dmnd`, `start:dmnd`, `verify:dmnd-runtime`). It is maintainer tooling and is not needed to run, build or contribute to the application.

## Project layout

| Location | Responsibility |
| --- | --- |
| `web/app/` | Public pages and fixed same-origin API routes |
| `web/components/wallet/`, `activity/` | Compact tables and expandable position and transaction detail |
| `web/lib/dmnd/` | Generated types, registry, validation, server gateway |
| `web/lib/portfolio/` | Protocol presentation adapters; no on-chain decoding |
| `web/lib/watchlist.ts`, `use-watchlist.ts`, `web/components/watchlist/` | Versioned browser-local saved addresses; no data acquisition |
| `web/lib/fixtures/` | Synthetic test data; there is no public fixture endpoint |
| `web/contracts/` | Pinned DMND OpenAPI contract and source revision |
| `web/tests/` | Synthetic fixtures and isolated Chromium flows |
| `web/scripts/` | Build, runtime and staged live-verification tooling |
| `scripts/` | Contract synchronization |

The application uses React, TypeScript and the Sites Vinext runtime.

## Data principles

The headline uses DMND's authoritative known net value. Doxxd does not sum protocol pages or calculate financial positions. Unknown values remain unknown; missing data does not establish an empty wallet. Receipt references are labeled as overlapping holdings. LP position NFTs in holdings are labeled as position receipts that overlap protocol positions; they are never priced or valued, and their creator-supplied token metadata is not a verification signal. Source clocks, coverage, debt, raw rewards and page-scoped subtotals retain their upstream meaning.

Expanded Marginfi details preserve raw shares, bank amounts, underlying quantities and independent price/bank/position clocks. Expanded spot/perp details preserve raw scaled balances and exact source base/quote amounts. A scaled balance is not a token quantity; base/quote amounts are not USD, equity or profit. Saved protocol snapshots retain their incomplete coverage and disabled-scan reason even when a price observation is newer.

Expanded native-stake rows preserve raw account lamports, staker/withdrawer, lockup fields and activation/deactivation epochs. Epochs and Unix seconds remain source values; delegated lamports do not imply effective or withdrawable stake. Stored rows remain visible with partial coverage when acquisition is disabled.

The Wallet card lists the 10 highest-value priced tokens, then a **Show all** control. Tokens with no price or under $0.01 sit behind one "no price or tiny balances" line, and LP position NFTs collapse to one line that links to their protocol card. **Search observed holdings** searches every loaded token name, symbol and mint, including collapsed tokens and receipts, which are listed while a search is active. Showing more and searching make no additional wallet requests. The known subtotal in the card header and the coverage details describe the full loaded response, not only the rows listed; a search shows how many of the loaded holdings match. A search with no matches does not establish an empty wallet; blank token labels fall back to the mint.

Holdings show K/M/B token amounts; expanded rows keep exact quantities and raw atoms. The independent `positions` resource adds indexed buy/sell USD subtotals, trade counts, last-trade dates and explicitly labeled average-cost P&L estimates, joined by exact mint. Missing trading rows stay unknown, and native SOL never inherits wrapped SOL results. One page of 100 indexed tokens loads on its own; more pages need a click. These figures cover partial indexed history, not complete wallet profit: opening balances, transfers, fees and missing prices can change actual results.

Activity presents observed executions, transfers, fees and net changes without inferring DeFi actions from balance deltas. Expanded history coverage keeps token and native SOL capture starts, completeness, reason codes and source slots separate. An empty page does not establish an empty activity window; unavailable continuation is explained with a manual retry. UTC filters and opaque cursor pages remain in the URL. Neutral balance-change fallback has a separate cursor scope.

Expanded balance changes retain the exact source atoms, unit amount, decimals, observation kind, mint and transaction index. Compact amounts may be rounded for the table; the source amount remains available in the expansion. A native observation with no mint is identified as native SOL; an unknown token mint stays unknown.

Values are shown as reported by the upstream service; this is not financial advice.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the fixture rules, and the [Code of Conduct](CODE_OF_CONDUCT.md) for how we work together. Issues and pull requests are both appreciated.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Never post API keys or other credentials in issues or pull requests.

## License

[MIT](LICENSE) (c) 2026 Hank Wyatt

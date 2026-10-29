# Contributing to Doxxd

Thanks for helping. Doxxd is a small, focused project: a public Solana wallet portfolio and activity explorer. Bug reports, fixes, tests, documentation and well-scoped features are all welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Setup

You need Node 22.13 or newer. From the repository root:

```sh
cd web
npm run install:ci
```

CI installs with `npm ci --ignore-scripts`, and so should you when you install by hand. Nothing in the dependency tree needs an install script: the native addons that have one (`bigint-buffer`, `bufferutil`, `utf-8-validate`) all fall back to pure JavaScript.

## Run it

The development server runs without a key; wallet routes then show a connection state:

```sh
npm run dev -- --host 127.0.0.1 --port 4317
```

Open `http://127.0.0.1:4317/`. There is no public demo route. To exercise portfolio and activity states without a key, run the browser tests (`npm run test:e2e`); they intercept the browser's `/api/wallet` requests and answer them from the synthetic fixtures in `web/lib/fixtures/`. The test server itself gets only a synthetic key and an unreachable upstream address, so it cannot call DMND.

Live routes (`/wallet/<address>`) need a DMND API key supplied as a server environment variable. The names are in [`web/.env.example`](web/.env.example) and the [README](README.md#configuration): `DMND_API_BASE_URL`, `DMND_API_KEY` and `DMND_ENABLED_PROTOCOLS`. Never commit a key, put it in a URL, or expose it with a `NEXT_PUBLIC_` prefix. You do not need a key to contribute; the automated tests never call the live service.

## Checks

Run these from `web/` before opening a pull request, one at a time:

```sh
npm test
npm run typecheck
npx playwright install chromium --only-shell
npm run test:e2e
npm run build
```

The browser suite starts its own server on `127.0.0.1:4318` with a synthetic key and a deliberately invalid upstream, so it cannot reach DMND. It also starts a synthetic Solana RPC helper for the wallet-action flows on `127.0.0.1:4319`. Vinext allows one development server per checkout, so stop your own `npm run dev` first. On Linux hosts with container network churn, Chromium may abort loopback requests with `ERR_NETWORK_CHANGED`; running the suite in a disposable network namespace avoids it:

```sh
unshare --user --map-root-user --net sh -c 'ip link set lo up && npm run test:e2e'
```

CI runs the same checks on every pull request.

## Dependencies and overrides

Changing or regenerating `web/package-lock.json` needs npm 11 or newer, for example `npx npm@11 install`. The npm 10 that ships with Node 22 crashes with `Cannot read properties of null (reading 'edgesOut')` when it resolves the whole tree from scratch with vitest 4. `npm ci` and installing a single package still work on npm 10, so CI and normal setup are unaffected.

`web/package.json` `overrides` force patched versions of transitive dependencies that their parents pin exactly. Each one has a condition for removal; delete the override, regenerate the lockfile and run `npm audit` once the condition holds.

| Override | Why | Remove when |
| --- | --- | --- |
| `miniflare` -> `undici` 7.30.1 | The stable miniflare 4.x line pins `undici` 7.28.0 or older, which has published advisories. | A stable miniflare, as pinned by `@cloudflare/vite-plugin` and `wrangler`, depends on `undici` 7.30.1 or newer. |
| `miniflare` -> `sharp` 0.35.5 | miniflare pins `sharp` 0.35.2, which has a published advisory. | A stable miniflare depends on `sharp` 0.35.5 or newer. |
| `@esbuild-kit/core-utils` -> `esbuild` 0.25.12 | `drizzle-kit` (used only by `npm run db:generate`) still depends on the deprecated `@esbuild-kit` loader, which pins `esbuild` 0.18.20. | `drizzle-kit` drops `@esbuild-kit`, or `@esbuild-kit/core-utils` allows `esbuild` 0.25 or newer. |
| `vinext` -> `image-size` 2.0.3 | vinext 1.0.0-beta.5 pins `image-size` 2.0.2, which has a published advisory. | The vinext version in use depends on `image-size` 2.0.3 or newer. |
| `@coral-xyz/anchor` -> `toml` 5.0.1 | The Meteora SDK's Anchor 0.31.1 pins `toml` ^3.0.0, which has published advisories. Anchor only parses `Anchor.toml` in its Node workspace helper, which Doxxd does not call. | Anchor depends on `toml` 5.0.1 or newer. |
| `jayson` -> `uuid` 11.1.1 | `@solana/web3.js` 1.99.0 uses `jayson` 4.3.0, which pins `uuid` ^8.3.2 (advisory for versions below 11.1.1). The browser build of web3.js uses only `uuid.v4()`, which 11.1.1 keeps. | `@solana/web3.js` or `jayson` depends on `uuid` 11.1.1 or newer. |

### Accepted advisories

On-site LP actions add the Solana SDKs, which bring transitive findings that have no compatible patched release. They are listed here instead of being hidden. Re-check each condition whenever the SDKs are bumped. This code ships only in the lazy action chunk (`web/lib/actions/build`); the Worker bundle gets a stub instead (`web/lib/actions/ssr-stub-plugin.ts`), and the browser loads the chunk only when a visitor starts an action.

| Finding | Path | Reachability | Remove when |
| --- | --- | --- | --- |
| `bigint-buffer` (high, buffer overflow in `toBigIntLE`; no patched release exists), reported again on `@solana/buffer-layout-utils`, `@solana/spl-token`, `@meteora-ag/cp-amm-sdk` and `@raydium-io/raydium-sdk-v2` | SDKs -> `@solana/spl-token` -> `@solana/buffer-layout-utils` -> `bigint-buffer` | Not in the Worker (stubbed). In the browser the package's `browser` field selects its pure-JavaScript implementation, not the native binding; the input is token and pool account data the visitor's own browser reads from the chain. | `bigint-buffer` publishes a patched release, or `@solana/spl-token` and the SDKs drop it. |
| `stream-json` (moderate, DoS and prototype pollution; fixed only in 3.6.0, an ESM-only major with a different API), reported again on `jayson`, `@solana/web3.js`, `@coral-xyz/borsh`, `@solana/spl-token-group` and `@solana/spl-token-metadata` | `@solana/web3.js` -> `jayson` -> `stream-json` | Not overridden: `jayson` 4.3.0 loads it with `require` and the 3.x API differs. Only `jayson/lib/utils.js` (Node stream helpers) uses it. web3.js's browser build imports `jayson/lib/client/browser`, which never loads it, and the Worker gets the stub. | `@solana/web3.js` drops `jayson`, or `jayson` moves to a patched `stream-json`. |
| `@vercel/og`, `satori` and `vinext` (moderate, SVG escaping) | `vinext` -> `@vercel/og` -> `satori` | Present before LP actions. Doxxd renders no OG images. | A vinext release depends on a patched `@vercel/og`. |

## Pull requests

- Keep each pull request small and focused on one change. Open an issue first for anything large.
- Use [conventional commits](https://www.conventionalcommits.org/): `type(scope): imperative summary`, for example `fix(activity): keep the cursor when the date filter changes`.
- Add or update tests with the change. New decoder or data-format behavior needs representative fixtures and regression coverage.
- Follow the data principles in the README. Unknown values stay unknown, and the UI must not infer financial meaning that the upstream data does not state.

## Secrets, personal data and fixtures

This is a public repository. Never commit:

- API keys, tokens, passwords, `.env` files (other than `web/.env.example`) or private key files.
- Personal information: names, personal email addresses, home-directory paths or machine names.
- Real wallet data: real wallet addresses, transaction signatures, account addresses, recorded API responses or screenshots of real wallets. A recording with the addresses swapped can still identify a wallet through its exact amounts, slots and times.

Test fixtures must be synthetic. Invent values, or derive them deterministically (for example from a hash of a label), and keep them internally consistent so tests still mean something. Well-known public IDs such as the system and token programs, wrapped SOL and USDC are fine. Screenshots must show synthetic fixture data only, for example from a browser test that serves the fixtures.

Secret scanning and push protection are enabled on this repository. If you think a secret was committed, report it privately as described in [SECURITY.md](SECURITY.md) instead of opening an issue.

## Generated files

`web/contracts/`, `web/lib/dmnd/generated.ts` and `web/lib/dmnd/validation.generated.json` are generated. Never edit them by hand. The pinned OpenAPI contract and its source revision live in `web/contracts/`. Updating the pin is normally a maintainer task because it needs a local checkout of the DMND API repository; regenerate from a reviewed full commit, never from a moving branch:

```sh
# Repository root.
node scripts/sync-dmnd-contract.mjs --repo /path/to/dmnd --ref <full-commit-sha>
cd web
npm run contracts:generate
```

Regenerate and check `git diff --exit-code -- contracts lib/dmnd/generated.ts lib/dmnd/validation.generated.json` to confirm there is no drift. Builds need no sibling DMND repository.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

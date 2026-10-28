# Contributing to Doxxd

Thanks for helping. Doxxd is a small, focused project: a public Solana wallet portfolio and activity explorer. Bug reports, fixes, tests, documentation and well-scoped features are all welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Setup

You need Node 22.13 or newer. From the repository root:

```sh
cd web
npm run install:ci
```

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

The browser suite starts its own server on `127.0.0.1:4318` with a synthetic key and a deliberately invalid upstream, so it cannot reach DMND. Vinext allows one development server per checkout, so stop your own `npm run dev` first. On Linux hosts with container network churn, Chromium may abort loopback requests with `ERR_NETWORK_CHANGED`; running the suite in a disposable network namespace avoids it:

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

# Contributing to Doxxd

Thanks for helping. Doxxd is a small, focused project: a public Solana wallet portfolio and activity explorer. Bug reports, fixes, tests, documentation and well-scoped features are all welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Setup

You need Node 22.13 or newer. From the repository root:

```sh
cd web
npm run install:ci
```

## Run it

The demo needs no key and makes no network calls to DMND:

```sh
npm run dev -- --host 127.0.0.1 --port 4317
```

Open `http://127.0.0.1:4317/demo`. `?tab=activity` shows synthetic activity, and `?scenario=` selects `pending`, `partial`, `stale`, `unpriced`, `empty`, `protocol-error`, `activity-continuation` or `truncated`.

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

## Pull requests

- Keep each pull request small and focused on one change. Open an issue first for anything large.
- Use [conventional commits](https://www.conventionalcommits.org/): `type(scope): imperative summary`, for example `fix(activity): keep the cursor when the date filter changes`.
- Add or update tests with the change. New decoder or data-format behavior needs representative fixtures and regression coverage.
- Follow the data principles in the README. Unknown values stay unknown, and the UI must not infer financial meaning that the upstream data does not state.

## Fixtures: synthetic data only

Test fixtures and demo data must be synthetic. Never commit real wallet addresses, transaction signatures, API keys, private recordings or screenshots of real wallets. Invent values, or derive them deterministically (for example from a hash of a label), and keep them internally consistent so tests still mean something. Well-known public IDs such as the system and token programs, wrapped SOL and USDC are fine.

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

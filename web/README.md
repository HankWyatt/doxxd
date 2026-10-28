# Doxxd web

See the [repository README](../README.md) for setup and configuration, and [CONTRIBUTING.md](../CONTRIBUTING.md) for verification and contract synchronization.

This application retains the Sites Vinext starter's portable runtime integration. `npm run dev` starts Vinext; `npm run build` builds the Worker; `npm start` previews the built Worker locally through Wrangler. These commands do not deploy. Runtime state in `.sites-runtime/`, `.vinext/`, `.wrangler/` and `dist/` is generated and ignored.

Preserve `scripts/`, `vite.config.ts`, `worker/index.ts`, `.openai/hosting.json`, `cloudflare-env.d.ts` and the package lock when changing framework integration. The starter includes optional D1/connector/auth examples; Doxxd's public wallet views do not require them.

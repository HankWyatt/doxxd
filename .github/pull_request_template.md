## Summary

<!-- What changed and why. Link the issue if there is one. -->

## Checks

Run from `web/`:

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run test:e2e` (if the change touches the UI or routes)
- [ ] `npm run build`

## Checklist

- [ ] The change is small and focused on one thing
- [ ] Tests added or updated, with synthetic fixtures only
- [ ] No real wallets, signatures, API keys or private recordings are included
- [ ] Generated files (`web/contracts/`, `web/lib/dmnd/generated.ts`, `web/lib/dmnd/validation.generated.json`) are untouched, or were regenerated with `npm run contracts:generate`
- [ ] Commit messages follow conventional commits

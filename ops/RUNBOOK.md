# Operator runbook

Local:

```bash
npm install
npm test
npm run sync-docs   # from a sibling ../darsay checkout at the lock SHA
npm run dev         # Astro only (docs + landing; API 404s)
npx wrangler d1 migrations apply darsay-io --local
npx wrangler dev    # Worker + local D1 + static assets after `npm run build`
```

## Cloudflare (when an account exists)

1. Move `darsay.io` nameservers to Cloudflare.
2. Zone Redirect Rule: `https://www.darsay.io/*` → `https://darsay.io/$1`.
3. `npx wrangler d1 create darsay-io` and `darsay-io-preview`. Put the IDs in `wrangler.jsonc` (replace the placeholders).
4. `npx wrangler d1 migrations apply darsay-io`
5. `npx wrangler d1 migrations apply darsay-io-preview --env preview`
6. Attach custom domain `darsay.io` on the Worker. Keep `workers_dev: false`.
7. Cloudflare Access on preview URLs.
8. `PUBLIC_BOARDS_ENABLED=true npm run build && npx wrangler deploy`

## Backups

```bash
npx wrangler d1 export darsay-io --output backup.sql
```

Exports contain board ids (capability secrets). Store them like secrets.

Time Travel: 7 days on D1 Free. Practice a restore on the preview database once.

## Caps

Dashboard: D1 rows written / read, Worker requests. Alert at 50% and 80% of Free daily caps.

- 100 board creates / UTC day
- 10 000 entry mutations / UTC day
- 50 000 board-id lookups / UTC day

## Docs lock

When the CLI tags a release, bump `docs.lock.json` `ref` + `sha` and run `npm run sync-docs`. Commit the generated `src/content/docs/docs/**`.

# Operator runbook

## Provisioning model

Wrangler (`wrangler.jsonc` + `migrations/`) is the source of truth for the Worker and D1. There is no Terraform, Ansible, or provision script in v1.

This is one operator, one zone, one Worker, two D1 databases. A second IaC stack would fight Wrangler for the same Worker (Cloudflare: do not manage one Worker in both). Recreating the account is the procedure below, not a Terraform project.

**Wrangler owns:** Worker name and preview env, `workers_dev: false`, apex custom domain (`routes`), D1 names and bindings, SQL migrations, observability, deploy.

**Dashboard / registrar (one-time):** nameservers at Cloudflare; `www` → apex Redirect Rule; keep MX/SPF for email forwarding; Cloudflare Access on preview URLs (before sharing a preview link); `npx wrangler login` on each machine.

**Do not** omit `database_id` so deploy auto-creates D1. Prod and preview must stay two named databases that never share data. Auto-provision still needs the UUID in config before `d1 migrations apply --remote`. Create explicitly and commit the IDs (they are not secrets).

**Revisit Terraform** (zone only, never the Worker) only if there is a second production-like account, a second domain, CI that must create Access / Redirect Rules / DNS unattended, or more than one person who will recreate the zone. A small idempotent helper around `d1 create` is optional after the first successful create; do not write it before then.

## Local

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
2. Zone Redirect Rule: `https://www.darsay.io/*` → `https://darsay.io/$1`. Do not attach `www` as a second Worker custom domain.
3. Create the two D1 databases (prod and preview). Prefer Wrangler writing the IDs:

   ```bash
   npx wrangler d1 create darsay-io --update-config --binding DB
   npx wrangler d1 create darsay-io-preview --update-config --binding DB --env preview
   ```

   If `--update-config` writes the wrong block, paste each printed `database_id` into the matching `d1_databases` entry in `wrangler.jsonc`. Replace the all-zero placeholders. Commit the IDs.
4. `npx wrangler d1 migrations apply darsay-io`
5. `npx wrangler d1 migrations apply darsay-io-preview --env preview`
6. Apex `darsay.io` is already in `wrangler.jsonc` `routes`. Deploy attaches it. Keep `workers_dev: false`.
7. Cloudflare Access on preview URLs (dashboard; before sharing a preview link).
8. `PUBLIC_BOARDS_ENABLED=true npm run build && npx wrangler deploy`

## Backups

```bash
npx wrangler d1 export darsay-io --output backup.sql
```

Exports contain board ids (capability secrets). Store them like secrets.
Do not commit `backup.sql` (gitignored).

Time Travel: 7 days on D1 Free. Practice a restore on the preview database once.

## Caps

Dashboard: D1 rows written / read, Worker requests. Alert at 50% and 80% of Free daily caps.

- 100 board creates / UTC day
- 10 000 entry mutations / UTC day
- 50 000 board-id lookups / UTC day

## Docs lock

When the CLI tags a release, bump `docs.lock.json` `ref` + `sha` and run `npm run sync-docs`. Commit the generated `src/content/docs/docs/**`.

# darsay.io website

Astro + Starlight + a Cloudflare Worker for anonymous want-list boards.

- Docs Markdown is generated (`npm run sync-docs`) from the CLI GitHub Release pinned in `docs.lock.json`. Do not hand-edit `src/content/docs/docs/**`. Bump the lock with `npm run bump-docs-lock` (or the `Sync CLI docs` workflow), never by editing the JSON alone. A CLI release normally needs no hands at all: release → `Sync CLI docs` (commits the pin to `main`) → `Deploy` (RUNBOOK § Docs lock).
- The site never stores model bytes. JSON API only. No R2.
- Board URL is the capability. No accounts. No Turnstile in v1.
- `CREATE_PASSWORD` is a Wrangler secret for POST `/api/boards` only. Never put it in git, `wrangler.jsonc` vars, or client JS.
- `catalog.json` export is schema 1.2.0 and still carries no holders/status/claims/GUID. POST of the same path imports a catalog document (the darsay CLI round trip): authoritative for entries/desire/note/digests, upsert+prune by (source, revision, include set); board-side fields survive on kept rows.
- Claims (`claim_json`, `POST/DELETE /api/boards/:id/entries/:eid/claim`) are board-side coordination like holders/status — never exported in catalog.json. Reporting `done` is the one client write to human columns (status→have; empty holders learns the client).
- Tests: `npm test`. Build: `PUBLIC_BOARDS_ENABLED=true npm run build`.
- Do not put a Node toolchain in `darsay/darsay` (the Python CLI repo).
- Provisioning is Wrangler + `ops/RUNBOOK.md`. Do not add Terraform, Ansible, or D1 auto-provision (omit `database_id`).
- `public/robots.txt` may only Disallow `/b/`, `/api/`, `/boards`. Do not add GPTBot/ClaudeBot (or other AI crawler) Disallows; product docs should stay fetchable. Cloudflare dashboard AI-bot policy lives in `ops/RUNBOOK.md`.
- Board recipe cards live in `src/lib/recipes.ts`: static, derived from entry fields only (no new catalog fields, no fetch per card). Command wording mirrors the CLI's `examples/README.md`; user text only ever appears inside `shellQuote`/`quoteGlob` single quotes, never in `#` comments, and is rendered with `textContent`.

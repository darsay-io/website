# darsay.io website

Astro + Starlight + a Cloudflare Worker for anonymous want-list boards.

- Docs Markdown is generated (`npm run sync-docs`) from the CLI tag in `docs.lock.json`. Do not hand-edit `src/content/docs/docs/**`.
- The site never stores model bytes. JSON API only. No R2.
- Board URL is the capability. No accounts. No Turnstile in v1.
- `CREATE_PASSWORD` is a Wrangler secret for POST `/api/boards` only. Never put it in git, `wrangler.jsonc` vars, or client JS.
- `catalog.json` export must stay schema 1.0.0 (no holders/status/GUID).
- Tests: `npm test`. Build: `PUBLIC_BOARDS_ENABLED=true npm run build`.
- Do not put a Node toolchain in `darsay/darsay` (the Python CLI repo).
- Provisioning is Wrangler + `ops/RUNBOOK.md`. Do not add Terraform, Ansible, or D1 auto-provision (omit `database_id`).
- `public/robots.txt` may only Disallow `/b/`, `/api/`, `/boards`. Do not add GPTBot/ClaudeBot (or other AI crawler) Disallows; product docs should stay fetchable. Cloudflare dashboard AI-bot policy lives in `ops/RUNBOOK.md`.

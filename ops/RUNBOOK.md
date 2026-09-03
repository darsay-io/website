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
4. `npx wrangler d1 migrations apply darsay-io --remote`
5. `npx wrangler d1 migrations apply darsay-io-preview --env preview --remote`
6. Apex `darsay.io` is already in `wrangler.jsonc` `routes`. Deploy attaches it. Keep `workers_dev: false`. Preview must set `"routes": []` so it does not inherit the apex custom domain.
7. Cloudflare Access on preview URLs (dashboard; before sharing a preview link).
8. `PUBLIC_BOARDS_ENABLED=true npm run build && npx wrangler deploy --env=""`
9. Shared create password (POST `/api/boards` only). Pick a phrase, do not commit it:

   ```bash
   npx wrangler secret put CREATE_PASSWORD --env=""
   ```

   Local: put `CREATE_PASSWORD=…` in `.dev.vars` (gitignored). If the secret is unset, create returns 503. Board view/edit still uses the URL only.
10. AI crawler dashboard policy: see [AI crawlers](#ai-crawlers). Product docs Allow; boards stay unlisted via origin `robots.txt` only.

## API clients and bot protection

`/api/**` is a JSON API for non-browser clients: the darsay CLI does its
board round trip (fetch → classify → push) and claim reports here,
identifying itself as `User-Agent: darsay/<version> (+https://darsay.io)`.
Cloudflare's Browser Integrity Check bans the bare `Python-urllib`
signature (403, error 1010) — darsay ≥ 0.14.6 sends its own UA, verified
live 2026-08-31. Keep it that way:

- Do **not** enable Bot Fight Mode or Super Bot Fight Mode; they
  fingerprint scripted TLS clients regardless of User-Agent and would
  block the CLI. If bot protection is ever needed, add a WAF custom rule
  that **skips** Browser Integrity Check and bot mitigation for
  `(http.host eq "darsay.io" and starts_with(http.request.uri.path, "/api/"))`.
- The board URL is the capability and the worker enforces its own body
  caps and daily mutate caps; the API needs no browser challenge.

## Migrations before the worker

A worker that queries a table its database lacks answers 500 on every
board. When a change adds a migration, apply it to **both** databases
before the deploy — the `Deploy` workflow auto-runs on docs pushes and
would ship the worker first otherwise:

```bash
npx wrangler d1 migrations apply darsay-io --remote
npx wrangler d1 migrations apply darsay-io-preview --env preview --remote
npx wrangler d1 migrations list darsay-io --remote     # nothing pending
PUBLIC_BOARDS_ENABLED=true npm run build && npx wrangler deploy --env=""
```

`0003_agents.sql` (revision, `updated`/`dropped` on rows, `keys`, `audit`,
`idempotency`, `webhooks`) is additive; old rows read back with
`updated = null` (the API falls back to `added`) and `dropped = null`.

## Keys, webhooks, and the audit trail

- Keys (`darsay_` + 48 hex) are stored as SHA-256 hashes. A leaked key is
  revoked from the board's ✦ Agents panel or `DELETE /api/boards/<id>/keys/<kid>`;
  there is no way to read a secret back. A leaked board URL is still the
  whole board — rotate by creating a new board and applying the catalog.
- Webhook secrets are stored in the clear (the worker must sign with
  them). Deliveries go out through `waitUntil` with a 10 s timeout and no
  retries; `last_status` on the hook is the only delivery record.
  Webhook URLs must be public https — the worker refuses loopback,
  private ranges, and IP literals — and a delivery never carries the
  board id.
- The audit trail keeps the last 1000 events per board; idempotency
  records age out after a day. Both live in D1 and count toward the row
  quota, roughly one audit row per write.
- A board delete cascades to entries, keys, audit, idempotency, and
  webhooks (`ON DELETE CASCADE`; the test database runs with
  `PRAGMA foreign_keys = ON`, as D1 does).

## Create password

`CREATE_PASSWORD` is a Wrangler **secret**, not `wrangler.jsonc` `vars` (those are visible in the dashboard and would land in git). The Worker compares the JSON body field `password` on create and discards it. It never writes the phrase to D1. To rotate: `secret put` again and tell friends. To remove the gate: delete the secret and the check in `src/worker/index.ts`.

## AI crawlers

Product pages (`/`, `/docs/**`) should be fetchable by AI search, chat agents, and training crawlers so people can ask an assistant about darsay. Boards stay unlisted. Verified live 2026-08-29: origin-only `robots.txt` (no Cloudflare managed prepend), HTTP 200 for GPTBot / ChatGPT-User / ClaudeBot / Claude-User / OAI-SearchBot / PerplexityBot.

**Origin file** (`public/robots.txt`, in git): `Disallow` `/b/`, `/api/`, `/boards` only. Do not add `GPTBot` / `ClaudeBot` / other AI-crawler `Disallow`s here. Do not delete this file; it is not the Cloudflare injector.

**Dashboard** (not in git). Select the **darsay.io zone**, not account home and not Workers.

| Setting | Value | Where |
| --- | --- | --- |
| Search / Agent / Training | Allow (do not block) | **Security** → **Settings**, filter **Bot traffic**, or **Configure AI bot policies** |
| Managed robots.txt | Off | **AI Crawl Control** → **Overview** / **Signals** / **Directives** / **Robots.txt** (card: Managed robots.txt). Same toggle may appear as **Set your preference to block training in robots.txt** or **Instruct AI bot traffic with robots.txt** |
| Bot Preference Sync | Off | Same Bot traffic / AI bot policies card |
| Display Content Signals Policy | Off | Zone **Overview** → **Control AI Crawlers** |
| Block AI Bots (legacy) | Off | **Security** → **Settings**, filter **Bot traffic** |
| AI Labyrinth | Off | Same |
| Per-crawler actions | Allow | **AI Crawl Control** → **Crawlers** / **Security** (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot) |

Keep origin `robots.txt`. The Cloudflare “robots.txt configuration” / “block training” toggle is the edge prepend (`# BEGIN Cloudflare Managed content`); turning that off does not disable your board `Disallow`s.

A browser load of `https://darsay.io/robots.txt` can look clean while identified AI clients still get the managed prepend. Re-check after dashboard changes:

```bash
# Must be origin-only: no "BEGIN Cloudflare Managed content", no GPTBot Disallow
curl -s https://darsay.io/robots.txt
curl -s -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" \
  https://darsay.io/robots.txt

# Must be HTTP 200, not 403 "Your request was blocked."
for ua in \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)" \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" \
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)"
do
  printf '%s -> ' "$ua"
  curl -sI -A "$ua" https://darsay.io/ | awk 'NR==1{print}'
done
```

GitHub org `darsay-io` needs nothing extra: public repos are already public. `github.com/robots.txt` is GitHub-wide (file trees / raw are restricted for `User-agent: *`). There is no org toggle that opens that up for third-party AIs.

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
- 10 000 entry mutations / UTC day (one per commit: an `apply` of 100 rows is one)
- 50 000 board-id lookups / UTC day (every board call, MCP included; the guide and the OpenAPI document are free)
- Per request: `apply`/`batch` price at most 12 new Hub rows (up to three
  subrequests each) to stay under the free plan's 50-subrequest limit.

## Public repo

This repository is public. Treat every committed file as world-readable.

**Commit these (identifiers, not credentials):**

- D1 `database_id` UUIDs in `wrangler.jsonc`
- Worker names, routes, schema SQL, `PUBLIC_BOARDS_ENABLED`

A D1 id names a database on *your* account. The D1 HTTP API is not open. Listing or querying it still requires Wrangler OAuth or a Cloudflare API token, which never go in git. Someone who already has your Cloudflare login can `wrangler d1 list` anyway.

**Never commit:**

- Wrangler OAuth (`~/Library/Preferences/.wrangler/` on this Mac)
- `CLOUDFLARE_API_TOKEN`
- `.dev.vars`, `.env` (except `.env.example`)
- D1 exports (`*.sql` dumps) — they contain board ids
- Local `.wrangler/state/` SQLite
- Board URLs (`/b/<32-hex>`) and catalog GET URLs
- Zone file dumps (`darsay.io.txt`)

**Already public and expected:** git author email, `NOTICE` copyright name.

## Docs lock

Production `/docs/` tracks the latest **CLI GitHub Release**, not `main`. `docs.lock.json` holds that tag and commit.

A CLI release flows to production with no hands, in three workflows:

1. The CLI repo's `Release` workflow dispatches `Sync CLI docs` here after
   publishing (secret `WEBSITE_DISPATCH_TOKEN` in `darsay-io/darsay`; the
   hourly cron is the fallback for missed dispatches).
2. `Sync CLI docs` (dispatch, hourly cron, and `workflow_dispatch` with an
   optional tag) compares the lock to `darsay-io/darsay`'s latest release.
   If they differ it regenerates `src/content/docs/docs/**`, verifies
   (test / `check:docs` / build — any failure pushes nothing), and commits
   straight to `main`; no PR. The push uses the `DOCS_PUSH_TOKEN` secret —
   the same fine-grained PAT as the dispatch token — because a push by the
   default `github.token` triggers no workflows, so Deploy would not fire.
3. `Deploy` runs on `main` pushes touching the lock, `src/content/docs/**`,
   or the logo (and on `workflow_dispatch` for anything else): test,
   `check:docs`, build, `wrangler deploy` (secrets `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`).

Any missing secret degrades a step, never the pipeline's safety: without
`DOCS_PUSH_TOKEN` the pin still lands on `main` but Deploy must be run by
hand (`workflow_dispatch`); without the Cloudflare secrets Deploy fails
visibly. The manual flow always works:

```bash
PUBLIC_BOARDS_ENABLED=true npm run build && npx wrangler deploy --env=""
```

Manual bump from a sibling CLI checkout:

```bash
npm run bump-docs-lock           # latest GitHub Release
npm run bump-docs-lock -- v0.10.0
```

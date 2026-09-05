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

A worker that writes a column its database lacks answers 503 (`quota`,
"The ledger could not be written") on every board write while reads keep
working, so the page looks fine and every Add fails. The `Deploy` workflow
applies pending migrations to **production** before `wrangler deploy`, so
a docs pin landing on `main` can no longer ship a worker ahead of its
schema; the `CLOUDFLARE_API_TOKEN` secret therefore needs D1 edit as well
as Workers edit. Preview is not deployed by that workflow, so when a change
adds a migration, bring preview up by hand, and do the same for production
whenever you deploy it by hand:

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

## MCP discovery and the registry

What a program that knows only darsay.io can fetch, and what each is for:

| Address | Serves |
|---|---|
| `/.well-known/mcp-server-card`, `/mcp/server-card` | The server card (`src/worker/card.ts`): the endpoint, the protocol revisions, the `Authorization` header. The MCP Registry's `server.json` shape. Cacheable for an hour. |
| `/mcp` | The server. `server/discover` answers any bearer, with or without `_meta`. Revision 2026-07-28 and the `initialize` era share it. |
| `/openapi.json` | Cacheable for ten minutes. |
| `/llms.txt` | Built from the docs page list (`scripts/llms.mjs`); a static asset, no Worker. |
| `/agents/` | The same surface as a page (`src/pages/agents.astro`): every interface an ordinary `<a href>` in the static HTML, and how a board's id names its operations — for a reader that sees neither `<head>` nor headers, and for a search for "darsay MCP". Public and indexable; it names no board. |

Every HTML page carries `<link rel="mcp" href="/.well-known/mcp-server-card">` (the Plain layout and Starlight's `head`) and `public/_headers` adds the same as a `Link` header. Every page's footer links to `/agents/` (the Plain layout; the docs through the Starlight `Footer` override in `src/components/starlight/`). The board shell gets `<link rel="alternate">` to its JSON from the worker, which also turns the shell's `data-board-json` marker into the same address as an anchor in the body, beside the shell's own link to `/agents/`. `robots.txt` needs nothing: none of these is under `/b/`, `/api/`, or `/boards` (the `/api/mcp/server-card` spelling is, on purpose — the well-known address is the one to publish).

Boards stay out of search, and the walk above never leads back to one: `robots.txt` disallows `/b/`, `_headers` and the worker send `X-Robots-Tag: noindex, nofollow` on board pages and the API, the shell and the create page carry the `robots` meta, the sitemap filters `/b/` and `/boards` out, and neither `/agents/` nor `/llms.txt` names a board (`src/lib/discovery.test.ts`, `scripts/llms.test.mjs`). A fetcher that honors `robots.txt` on user-directed fetches cannot read a board page at all; it still finds `/agents/` from the site root or `/llms.txt`. Relaxing the `/b/` disallow while keeping `noindex` would open that door and is a policy call, not a bug.

Check after a deploy:

```sh
curl -s https://darsay.io/.well-known/mcp-server-card | jq '.remotes[0].supportedProtocolVersions'
curl -sI https://darsay.io/docs/ | grep -i '^link:'
curl -s https://darsay.io/agents/ | grep -o 'href="/[^"]*"' | sort -u          # every interface, as an anchor
curl -s https://darsay.io/b/<a board id> | grep -o '<a href="/b/[^"]*"'         # the board's JSON, in the body
curl -s -X POST https://darsay.io/mcp -H 'content-type: application/json' \
  -H 'Authorization: Bearer <a board id>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' | jq '.result.supportedVersions'
curl -s https://darsay.io/llms.txt | head
```

### Publishing to the MCP Registry

The registry (registry.modelcontextprotocol.io, in preview) lists public servers by name; ours is `io.darsay/board`, a name the registry grants to whoever proves darsay.io. The card *is* the `server.json`. Once, on a machine that will keep the key:

```sh
brew install mcp-publisher   # or the release tarball: modelcontextprotocol.io/registry/quickstart
openssl genpkey -algorithm Ed25519 -out darsay-registry-key.pem   # beside the Wrangler login; never in git
PUBLIC_KEY="$(openssl pkey -in darsay-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
printf 'v=MCPv1; k=ed25519; p=%s\n' "$PUBLIC_KEY" > public/.well-known/mcp-registry-auth
git add public/.well-known/mcp-registry-auth   # a public key: commit it, deploy it
```

Then, once that deploy is live, for each version of the server — the card's `version` is `MCP_SERVER.version` in `src/worker/mcp.ts`, and the registry refuses a version it already has, so bump it when the tools change:

```sh
PRIVATE_KEY="$(openssl pkey -in darsay-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain darsay.io --private-key "$PRIVATE_KEY"
curl -s https://darsay.io/mcp/server-card -o server.json
mcp-publisher publish
curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers?search=io.darsay/board' | jq '.servers[].name'
```

DNS is the other proof (`darsay.io. IN TXT "v=MCPv1; k=ed25519; p=…"` at the apex, then `mcp-publisher login dns`); the file is the better fit here because the site already serves `/.well-known/` and the record would sit beside the mail SPF.

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
- `public/.well-known/mcp-registry-auth` — the registry signing key's *public* half

A D1 id names a database on *your* account. The D1 HTTP API is not open. Listing or querying it still requires Wrangler OAuth or a Cloudflare API token, which never go in git. Someone who already has your Cloudflare login can `wrangler d1 list` anyway.

**Never commit:**

- Wrangler OAuth (`~/Library/Preferences/.wrangler/` on this Mac)
- `CLOUDFLARE_API_TOKEN`
- The registry signing key (`darsay-registry-key.pem`, any `*.pem`) and the `server.json` it publishes (a fetched copy of the card)
- `.dev.vars`, `.env` (except `.env.example`)
- D1 exports (`*.sql` dumps) — they contain board ids
- Local `.wrangler/state/` SQLite
- Board URLs (`/b/<32-hex>`) and catalog GET URLs
- Zone file dumps (`darsay.io.txt`)

**Already public and expected:** git author email, `NOTICE` copyright name.

## Credentials and permissions

Everything the site and the CLI's release pipeline need that is not in
git: where each one lives, the exact permission, how it is made, and what
proves it works. A rebuild from nothing creates these and nothing else.
Names are safe to write down; values never are.

| What | Lives in | Permissions | Proof it works |
|---|---|---|---|
| Cloudflare account login | A person, with 2FA and recovery codes | Owns the zone, the Worker, both D1 databases, the Worker secret. | Dashboard opens; `npx wrangler whoami` names the account. |
| Registrar login | A person | Nameservers point at Cloudflare; MX/SPF for mail forwarding live in the zone. | `dig NS darsay.io` answers Cloudflare nameservers. |
| Wrangler OAuth (`npx wrangler login`) | `~/Library/Preferences/.wrangler/` on each operator's machine | Whatever the login grants: deploy, D1 (migrations, exports), secrets. Hands-on only, never CI. | `npx wrangler d1 migrations list darsay-io --remote` answers. |
| `CLOUDFLARE_API_TOKEN` | `darsay-io/website` → Settings → Secrets → Actions | A Cloudflare API token scoped to this account (and the `darsay.io` zone): the **Edit Cloudflare Workers** template — Workers Scripts Edit, the routes the custom domain needs, static assets — **plus Account → D1 → Edit**, because `Deploy` applies migrations before it ships the worker. | `Deploy` green end to end. Verified 2026-09-03: with Workers edit alone the migration step answered code 7403 (*not authorized to access this service*); after D1 Edit was added, `Apply D1 migrations` and `Deploy to Cloudflare` both passed. |
| `CLOUDFLARE_ACCOUNT_ID` | Same place | An identifier, not a credential; kept as a secret only because `wrangler.jsonc` carries no `account_id`. Dashboard → Workers & Pages → Overview, or `npx wrangler whoami`. | Same run. |
| `CREATE_PASSWORD` | The Worker (`npx wrangler secret put CREATE_PASSWORD --env=""`), and `.dev.vars` locally | The shared create phrase; see [Create password](#create-password). | `POST /api/boards` with the phrase answers 201; without the secret, 503 `create_disabled`. |
| `GITHUB_TOKEN` (optional) | The Worker (`npx wrangler secret put GITHUB_TOKEN --env=""`), and `.dev.vars` locally | A GitHub token with **no scopes** (public repositories only), so pricing a code row — three REST calls per add: repository, commit, tree — is not bound by the unauthenticated allowance the Worker's egress addresses share. Absent or exhausted, a repository row still adds and lands unpriced; the CLI's `darsay estimate <board-url>` prices it on the next refresh. | Adding `github:octocat/Hello-World` answers 201 with `payload_bytes`; a 403 from the API leaves `payload_bytes` null, never a 5xx. |
| `DOCS_PUSH_TOKEN` | `darsay-io/website` secrets | A **fine-grained PAT** (resource owner `darsay-io`, repository `darsay-io/website` only): **Contents: Read and write** (the sync pushes the docs pin to `main`), **Actions: Read and write** (the CLI's release dispatches `Sync CLI docs` with the same token), Metadata: Read (implied). Pushes act as the token's owner, which is what makes `Deploy` fire. | The commit `docs: pin CLI docs to <tag>` on `main` shows the owner as author, and a `Deploy` run follows it. |
| `WEBSITE_DISPATCH_TOKEN` | `darsay-io/darsay` secrets | The same PAT, or one with only **Actions: Read and write** on `darsay-io/website`. | A release's *Nudge the website docs sync* step prints no `dispatch failed`. |
| GitHub environment `pypi` | `darsay-io/darsay` → Settings → Environments | Required reviewer(s), so a pushed tag cannot publish unattended. The `release` job runs in it with `contents: write` (the GitHub Release) and `id-token: write` (OIDC). | A `v*` tag push waits for approval, then publishes. |
| PyPI trusted publisher | PyPI → project `darsay` → Publishing | Owner `darsay-io`, repository `darsay`, workflow `release.yml`, environment `pypi`. **No PyPI API token exists anywhere.** The PyPI account (2FA, recovery codes) is the credential to keep. | The *Publish to PyPI* step succeeds; `pip index versions darsay` shows the version. |
| MCP registry signing key | `darsay-registry-key.pem` beside the Wrangler login, never in git; its public half in `public/.well-known/mcp-registry-auth` | Ed25519; see [Publishing to the MCP Registry](#publishing-to-the-mcp-registry). | `mcp-publisher publish` accepts the card. |
| Homebrew tap | `darsay-io/homebrew-darsay` | No secrets. The formula is bumped by hand to the PyPI sdist URL and its sha256. | `brew install darsay-io/darsay/darsay`. |

Permissions the workflows grant themselves (`permissions:` in each file,
nothing to configure): `Deploy` and `CI` read contents; `Sync CLI docs`
writes contents and issues; the CLI's `release` job writes contents and
the OIDC token. The repository-level default for `GITHUB_TOKEN` can stay at
read-only.

**Branch protection:** none on `main` in either repository, and the docs
sync depends on that — it pushes straight to `main`. If protection is ever
added, let the PAT's owner bypass it, or the pin stops landing.

**PAT expiry.** The token in use is believed to have no expiry. Check at
github.com → Settings → Developer settings → Personal access tokens: a
token listed as *No expiration* needs nothing here. If one is ever minted
with an expiry, note the date somewhere you will see it. When a PAT lapses
nothing breaks loudly: `Sync CLI docs` still lands the pin under
`github.token`, but `Deploy` does not fire and the release's nudge fails
quietly to the hourly cron — see [Docs lock](#docs-lock).

**Rebuild from nothing, in order:** the Cloudflare account and zone
([Cloudflare](#cloudflare-when-an-account-exists), steps 1–8), then the
Worker secret (step 9), then the API token and account id into the website
secrets, then the PAT into both repositories, then the `pypi` environment
and the PyPI trusted publisher, then the registry key. Finish by running
`Deploy` from the Actions tab and reading its `Apply D1 migrations` and
`Deploy to Cloudflare` steps: green there means every Cloudflare
permission is right.

**Rotate a Cloudflare token** by editing it in place (the value is
unchanged, nothing to update in GitHub) or by making a new one and running
`gh secret set CLOUDFLARE_API_TOKEN --repo darsay-io/website`. Either way,
check it before trusting it:

```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq .result.status   # "active"
gh workflow run deploy.yml --repo darsay-io/website && gh run watch --repo darsay-io/website
```

## Docs lock

`docs.lock.json` records a **CLI release tag or exact commit**, never a
moving branch. Release pins track the latest CLI GitHub Release. An exact
commit pin stays fixed: the scheduled sync skips it, and an explicit release
tag (including the CLI release workflow's dispatch) resumes release tracking.

Use `npm run bump-docs-lock -- <vX.Y.Z-or-full-commit-sha>` to resolve the
source and regenerate the lock, pages, and transform snapshots together.
Exact commit pins let coordinated CLI and website work stay consistent
without creating a release. Commit the CLI first, pin that full SHA here,
then commit the website. Publish the CLI commit before pushing the website:
CI and Deploy check out that exact SHA. Pinning locally neither publishes
the CLI nor deploys the site.

The transform derives its page list from the pinned source — every
`docs/*.md` becomes `/docs/<stem>/`, plus `examples/README.md` — so a new CLI
docs page publishes itself. What it will not do is guess: a relative link
that names nothing in the source checkout fails the sync rather than shipping
a dead link.

A CLI release flows to production with no hands, in three workflows, with a
fourth check upstream of all of them:

0. The CLI repo's `Docs site transform` job checks out this repo, runs
   `scripts/sync-docs.mjs` against the CLI commit under test, then `npm test`
   and the build. It runs on every CLI pull request and as a prerequisite of
   the `Release` job, so a new docs page or a renamed heading fails there —
   before the tag exists — instead of here, after it.
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
3. `Deploy` runs on every push to `main` — the docs pin's push is one
   more push — and on `workflow_dispatch` for a redeploy with nothing new
   to push: test, `check:docs`, build, `d1 migrations apply darsay-io
   --remote`, then `wrangler deploy` (secrets `CLOUDFLARE_API_TOKEN` with
   Workers edit and D1 edit, `CLOUDFLARE_ACCOUNT_ID`). A push by the
   default `github.token` triggers no workflow, which is why the sync
   pushes with the PAT.

### When a sync fails

A failure is a signal, not something to retry hourly. The first failing run
for a tag opens one issue labelled `docs-sync`, titled
`Sync CLI docs failed for <tag>`, carrying the error line, a link to the run,
and the `main` commit that failed. While that issue is open **and** `main` is
still at that commit, later runs print `skipped: <tag> already reported` and
exit 0 — the identical input is not re-run. Push the fix to `main` and the
next run tries again on its own; the run that succeeds comments the commit it
published and closes every open `docs-sync` report — including one for a tag
production has since moved past, which nothing would otherwise ever close.

So: to retry, fix `main` (or close the issue). Nothing else needs touching.
`Sync CLI docs` needs `issues: write` for this, which it has.

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

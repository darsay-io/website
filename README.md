# darsay.io

Product site and anonymous want-list leaderboards for [darsay](https://github.com/darsay-io/darsay).

This is documentation plus a coordination ledger. **It does not host model files.** Collectors run `darsay archive` from upstream, or sneakernet a vault.

```bash
npm install
npm test
npm run dev          # landing + docs
npm run build
npx wrangler d1 migrations apply darsay-io --local
npx wrangler dev     # API + local D1 (after build)
```

Board URLs look like `https://darsay.io/b/<32-hex>`. The URL is the password. Anyone with it can edit. Creating a board currently also needs a shared `CREATE_PASSWORD` Wrangler secret (not in this repo).

Catalog export is a `catalog.json` the CLI already understands:

```bash
# after downloading from the board UI
darsay catalog adopt summer ./catalog.json
darsay archive --next summer
```

The GET `…/catalog.json` URL is the same write capability as the board. Do not paste it into chat; use the download button.

See `ops/RUNBOOK.md` for Cloudflare. Wrangler is the provisioning tool; there is no Terraform or Ansible. Docs Markdown is pinned in `docs.lock.json` from the CLI tag; do not edit `src/content/docs/docs/**` by hand.

`wrangler.jsonc` D1 `database_id` values are not secrets; they identify the prod and preview databases. There are no API tokens in this repo. Keep `.dev.vars` and D1 exports out of git.

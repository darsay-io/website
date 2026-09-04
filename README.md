# darsay.io

Product site and anonymous want-list leaderboards for [darsay](https://github.com/darsay-io/darsay).

This is documentation plus a coordination ledger. **It does not host model files.** Collectors run `darsay archive` from upstream, or sneakernet a vault.

Every board size names its scope: repository inventory, selected files, or the classified archive. GGUF repositories list their variants and exact selection commands; **Add variant** creates a separately priced row without changing the original. Unknown file sizes appear as lower bounds. **Refresh size** updates Hub inventory, while `darsay estimate <board-url>` classifies archive contents. Catalogs use schema 3.0.0.

**Explore collection** opens the collection room before adding a Hub source: explicit starting points, complete shard groups, separate companions, live disk totals, field notes, and a pinned review. Multiple variants save as one collection row. `GET …/preview` inspects without writing. `src/lib/collection-guide.json` mirrors the CLI's packaged `collection_guide.json`; both clients use the same guidance and starting-point rules. See [Choosing a collection](src/content/docs/board/collections.mdx).

```bash
npm install
npm test
npm run dev          # landing + docs
npm run build
npx wrangler d1 migrations apply darsay-io --local
npx wrangler dev     # API + local D1 (after build)
```

For the browser regression check, serve the built site with local Wrangler on
port 8793 (override `CREATE_PASSWORD` with a disposable local value), and start
Chrome with a temporary profile and `--remote-debugging-port=9231`.
Run `COLLECTION_TEST_PASSWORD=<local-value> node scripts/check-collection-ui.mjs`.
It refuses non-local hosts, creates disposable local boards, and writes screenshots
to a new temporary directory. It checks live Hub inventory on desktop and phone
viewports, keyboard focus, cancel/review/save, duplicate identity, and explicit
uninspected scope. Controlled browser transport failures exercise retry and late
response handling; these are not claims of live upstream outage coverage.

Board URLs look like `https://darsay.io/b/<32-hex>`. The URL is the password. Anyone with it can edit. Creating a board currently also needs a shared `CREATE_PASSWORD` Wrangler secret (not in this repo).

Catalog export is a `catalog.json` the CLI already understands:

```bash
# after downloading from the board UI
darsay catalog adopt summer ./catalog.json
darsay archive --next summer
```

The GET `…/catalog.json` URL is the same write capability as the board. Do not paste it into chat; use the download button.

See `ops/RUNBOOK.md` for Cloudflare, including the dashboard AI-crawler policy (product docs should stay fetchable; boards stay unlisted). Wrangler is the provisioning tool; there is no Terraform or Ansible. Docs Markdown is pinned in `docs.lock.json` to a CLI release or exact commit; do not edit `src/content/docs/docs/**` by hand. Use `npm run bump-docs-lock -- <vX.Y.Z-or-full-commit-sha>` to update the pin, generated pages, and snapshots together. Release pins follow new CLI releases automatically; exact commit pins stay fixed until an explicit release tag is supplied. Publish the pinned CLI commit before pushing a website commit that references it.

`wrangler.jsonc` D1 `database_id` values are not secrets; they identify the prod and preview databases. There are no API tokens in this repo. Keep `.dev.vars` and D1 exports out of git.

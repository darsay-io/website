/**
 * The "For agents" dialog: this board, for programs. The addresses a
 * program reads (JSON, OpenAPI, MCP), the keys the URL can mint and
 * narrow, the webhooks it can register, and the recent activity — who did
 * what. Authored copy through `inline()`;
 * everything from the API is rendered with textContent.
 */
import { SCOPES, SCOPE_HELP, type Scope } from "../worker/access.ts";
import { copyOrSelect, el, inline, stage, toast } from "./dom.ts";
import { plural, relativeTime } from "./format.ts";

export type AgentsContext = {
	boardId: string;
	origin: string;
	api: (path: string, init?: RequestInit) => Promise<unknown>;
	/** Rows or keys changed under the dialog: repaint the board. */
	onChange: () => Promise<void>;
	humanError: (msg: string) => string;
};

export type Agents = { open: (from?: HTMLElement | null) => void; close: () => void };

type KeyRow = { id: string; label: string; scopes: Scope[]; created: string; last_used: string | null };
type WebhookRow = { id: string; url: string; events: string[]; created: string; last_at: string | null; last_status: number | null };
type AuditEvent = {
	id: number;
	at: string;
	actor: { label: string; client: string };
	action: string;
	entry_id: number | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
};

const ACTION_WORDS: Record<string, string> = {
	"board.updated": "edited the board",
	"row.added": "added",
	"row.updated": "updated",
	"row.dropped": "dropped",
	"row.restored": "restored",
	"row.removed": "removed",
	"claim.reported": "claimed",
	"claim.released": "released a claim on",
	"catalog.imported": "pushed a refreshed catalog",
	"key.created": "minted a key",
	"key.revoked": "revoked a key",
	"webhook.created": "registered a webhook",
	"webhook.removed": "removed a webhook",
};

function sourceOf(ev: AuditEvent): string | null {
	const s = (ev.after ?? ev.before)?.source;
	return typeof s === "string" ? s : null;
}

/** `huggingface:Qwen/Qwen3-0.6B` → `Qwen/Qwen3-0.6B`; a home URL keeps its host and tail. */
function shortSource(source: string): string {
	if (source.startsWith("huggingface:")) return source.slice("huggingface:".length).replace(/^datasets\//, "datasets/");
	try {
		const u = new URL(source);
		return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
	} catch {
		return source;
	}
}

function addressRow(label: string, value: string, note?: string): HTMLElement {
	const code = el("code", { class: "agents-addr-v" }, value);
	const copy = el("button", { type: "button", class: "btn compact cmd-copy" }, "Copy");
	copy.addEventListener("click", () => void copyOrSelect(copy, value, code));
	const row = el("div", { class: "agents-addr" }, el("span", { class: "agents-addr-k" }, label), code, copy);
	if (note) row.append(el("span", { class: "agents-addr-note" }, inline(note)));
	return row;
}

function section(title: string, lede: string): { root: HTMLElement; body: HTMLElement } {
	const body = el("div", { class: "agents-section-body" });
	const root = el("section", { class: "agents-section" }, el("h3", { class: "agents-h" }, title), el("p", { class: "agents-lede" }, inline(lede)), body);
	return { root, body };
}

export function createAgents(ctx: AgentsContext): Agents {
	let dlg: HTMLDialogElement | null = null;
	let opener: HTMLElement | null = null;
	let keysHost: HTMLElement | null = null;
	let hooksHost: HTMLElement | null = null;
	let activityHost: HTMLElement | null = null;
	let reveal: HTMLElement | null = null;

	const base = `/api/boards/${ctx.boardId}`;
	const jsonUrl = `${ctx.origin}/b/${ctx.boardId}.json`;
	const mcpUrl = `${ctx.origin}/mcp`;
	const openapiUrl = `${ctx.origin}/openapi.json`;

	function fail(err: unknown) {
		toast(ctx.humanError(err instanceof Error ? err.message : "failed"), "error");
	}

	async function refresh() {
		await Promise.all([paintKeys(), paintHooks(), paintActivity()]);
	}

	async function paintKeys() {
		if (!keysHost) return;
		try {
			const res = (await ctx.api(`${base}/keys`)) as { keys: KeyRow[]; max: number };
			keysHost.replaceChildren();
			if (!res.keys.length) {
				keysHost.append(el("p", { class: "agents-empty" }, "No keys yet. Everyone with the URL has the whole board; a key is how you hand an agent less."));
			}
			for (const k of res.keys) {
				const chips = el("span", { class: "agents-scopes" });
				for (const s of k.scopes) chips.append(el("span", { class: "chip chip-scope", title: SCOPE_HELP[s] }, s));
				const revoke = el("button", { type: "button", class: "btn compact secondary" }, "Revoke");
				revoke.addEventListener("click", async () => {
					revoke.disabled = true;
					try {
						await ctx.api(`${base}/keys/${k.id}`, { method: "DELETE" });
						toast(`Revoked ${k.label}`);
						await paintKeys();
						await paintActivity();
					} catch (err) {
						fail(err);
						revoke.disabled = false;
					}
				});
				keysHost.append(
					el(
						"div",
						{ class: "agents-key" },
						el("span", { class: "agents-key-label" }, k.label),
						chips,
						el("span", { class: "agents-key-when muted" }, k.last_used ? `used ${relativeTime(k.last_used)}` : `minted ${relativeTime(k.created)}, never used`),
						revoke,
					),
				);
			}
		} catch (err) {
			fail(err);
		}
	}

	function renderMintForm(): HTMLElement {
		const form = el("form", { class: "agents-mint" });
		const label = el("input", { type: "text", maxlength: "60", placeholder: "chatgpt, codex, the research bot", "aria-label": "Key label", autocomplete: "off" });
		const boxes = new Map<Scope, HTMLInputElement>();
		const scopeRow = el("div", { class: "agents-scope-picks" });
		for (const s of SCOPES) {
			if (s === "read") continue;
			const box = el("input", { type: "checkbox" });
			if (s === "write") box.checked = true;
			boxes.set(s, box);
			scopeRow.append(el("label", { class: `agents-scope-pick${s === "remove" ? " is-danger" : ""}`, title: SCOPE_HELP[s] }, box, el("span", {}, s)));
		}
		const mint = el("button", { type: "submit", class: "btn compact" }, "Mint a key");
		form.append(
			el("label", { class: "agents-mint-label" }, el("span", {}, "Label"), label),
			el("div", { class: "agents-mint-scopes" }, el("span", {}, "Scopes"), el("span", { class: "chip chip-scope is-implied", title: SCOPE_HELP.read }, "read"), scopeRow),
			mint,
		);
		form.addEventListener("submit", async (ev) => {
			ev.preventDefault();
			const name = label.value.trim();
			if (!name) {
				label.focus();
				return;
			}
			mint.disabled = true;
			try {
				const scopes = [...boxes.entries()].filter(([, b]) => b.checked).map(([s]) => s);
				const made = (await ctx.api(`${base}/keys`, { method: "POST", body: JSON.stringify({ label: name, scopes }) })) as { key: string; label: string; scopes: Scope[] };
				showReveal(made);
				label.value = "";
				toast(`Minted ${made.label}`);
				await paintKeys();
				await paintActivity();
			} catch (err) {
				fail(err);
			} finally {
				mint.disabled = false;
			}
		});
		return form;
	}

	function showReveal(made: { key: string; label: string; scopes: Scope[] }) {
		if (!reveal) return;
		reveal.replaceChildren(
			el("p", { class: "agents-reveal-k" }, el("span", { "aria-hidden": "true" }, "✦ "), `The key for ${made.label} — shown once. Copy it now; the board keeps only a hash.`),
			stage("the key", [made.key], "guide-stage agents-stage"),
			stage(
				"connect an agent",
				[
					`# Claude Code — the board as an MCP server`,
					`claude mcp add --transport http darsay ${mcpUrl} --header "Authorization: Bearer ${made.key}"`,
					``,
					`# any program — the board as JSON, no id in sight`,
					`curl -s -H "Authorization: Bearer ${made.key}" ${ctx.origin}/api/board | jq '.entries[] | [.desire, .status, .source]'`,
				],
				"guide-stage agents-stage",
			),
		);
		reveal.hidden = false;
	}

	async function paintHooks() {
		if (!hooksHost) return;
		try {
			const res = (await ctx.api(`${base}/webhooks`)) as { webhooks: WebhookRow[] };
			hooksHost.replaceChildren();
			if (!res.webhooks.length) hooksHost.append(el("p", { class: "agents-empty" }, "No listeners. A webhook gets one signed POST per change, with the rows before and after."));
			for (const h of res.webhooks) {
				const remove = el("button", { type: "button", class: "btn compact secondary" }, "Remove");
				remove.addEventListener("click", async () => {
					remove.disabled = true;
					try {
						await ctx.api(`${base}/webhooks/${h.id}`, { method: "DELETE" });
						toast("Webhook removed");
						await paintHooks();
						await paintActivity();
					} catch (err) {
						fail(err);
						remove.disabled = false;
					}
				});
				const status =
					h.last_status === null ? "never delivered" : h.last_status === 0 ? `unreachable ${relativeTime(h.last_at ?? h.created)}` : `${h.last_status} ${relativeTime(h.last_at ?? h.created)}`;
				hooksHost.append(
					el(
						"div",
						{ class: "agents-key" },
						el("code", { class: "agents-key-label agents-hook-url" }, h.url),
						el("span", { class: "agents-scopes" }, el("span", { class: "chip chip-scope" }, h.events.join(", "))),
						el("span", { class: "agents-key-when muted" }, status),
						remove,
					),
				);
			}
		} catch (err) {
			fail(err);
		}
	}

	function renderHookForm(): HTMLElement {
		const form = el("form", { class: "agents-mint" });
		const url = el("input", { type: "url", placeholder: "https://…", "aria-label": "Webhook URL", autocomplete: "off", inputmode: "url" });
		const add = el("button", { type: "submit", class: "btn compact secondary" }, "Register");
		form.append(el("label", { class: "agents-mint-label" }, el("span", {}, "Listener"), url), add);
		form.addEventListener("submit", async (ev) => {
			ev.preventDefault();
			if (!url.value.trim()) {
				url.focus();
				return;
			}
			add.disabled = true;
			try {
				const made = (await ctx.api(`${base}/webhooks`, { method: "POST", body: JSON.stringify({ url: url.value.trim() }) })) as { secret: string; url: string };
				if (reveal) {
					reveal.replaceChildren(
						el("p", { class: "agents-reveal-k" }, el("span", { "aria-hidden": "true" }, "✦ "), "The signing secret — shown once. Deliveries carry X-Darsay-Signature: sha256=<HMAC of the body>."),
						stage("the secret", [made.secret], "guide-stage agents-stage"),
					);
					reveal.hidden = false;
				}
				url.value = "";
				toast("Webhook registered");
				await paintHooks();
				await paintActivity();
			} catch (err) {
				fail(err);
			} finally {
				add.disabled = false;
			}
		});
		return form;
	}

	async function paintActivity() {
		if (!activityHost) return;
		try {
			const res = (await ctx.api(`${base}/audit?limit=20`)) as { events: AuditEvent[] };
			activityHost.replaceChildren();
			if (!res.events.length) {
				activityHost.append(el("p", { class: "agents-empty" }, "Nothing yet. Every edit — yours, the CLI's, a key's — lands here with before and after."));
				return;
			}
			const list = el("ol", { class: "agents-activity" });
			for (const ev of res.events) {
				const who = el("span", { class: `agents-who is-${ev.actor.client}` }, ev.actor.label);
				const what = el("span", { class: "agents-what" }, ACTION_WORDS[ev.action] ?? ev.action);
				const li = el("li", {}, el("time", { class: "agents-when", datetime: ev.at, title: ev.at }, relativeTime(ev.at)), who, what);
				const src = sourceOf(ev);
				if (src) li.append(el("code", { class: "agents-src" }, shortSource(src)));
				const changes = ev.after && Array.isArray(ev.after.changes) ? (ev.after.changes as string[]) : null;
				if (ev.action === "row.updated" && changes && changes.length) {
					li.append(el("span", { class: "agents-changes muted" }, changes.map((c) => `${c}: ${fmt(ev.before?.[c])} → ${fmt(ev.after?.[c])}`).join(" · ")));
				} else if (ev.action === "catalog.imported" && ev.after) {
					const a = ev.after as Record<string, number>;
					li.append(el("span", { class: "agents-changes muted" }, `${a.added ?? 0} added · ${a.updated ?? 0} updated · ${(a.removed ?? 0) + (a.dropped ?? 0)} gone`));
				} else if ((ev.action === "key.created" || ev.action === "key.revoked") && (ev.after ?? ev.before)) {
					const k = (ev.after ?? ev.before) as { label?: string };
					if (k.label) li.append(el("code", { class: "agents-src" }, k.label));
				} else if ((ev.action === "webhook.created" || ev.action === "webhook.removed") && (ev.after ?? ev.before)) {
					const w = (ev.after ?? ev.before) as { url?: string };
					if (w.url) li.append(el("code", { class: "agents-src" }, w.url));
				}
				list.append(li);
			}
			activityHost.append(list);
		} catch (err) {
			fail(err);
		}
	}

	function fmt(v: unknown): string {
		if (v === null || v === undefined || v === "") return "—";
		if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
		return String(v);
	}

	function build() {
		const d = el("dialog", { class: "guide agents", "aria-labelledby": "agents-title" });
		dlg = d;
		const close = el("button", { type: "button", class: "guide-close", "aria-label": "Close" }, "×");
		close.addEventListener("click", () => d.close());
		const bar = el("header", { class: "guide-bar" }, el("span", { class: "guide-kicker" }, el("span", { "aria-hidden": "true" }, "✦ "), "For agents"), el("span", { class: "guide-pos" }, "this board, for programs"), close);

		const art = el("article", { class: "guide-card agents-card", tabindex: "-1" });
		art.append(
			el("p", { class: "guide-group" }, "The ledger", el("span", { class: "guide-group-note" }, "same rows, no browser")),
			el("h2", { class: "guide-title", id: "agents-title" }, "One board, three doors"),
			el(
				"p",
				{ class: "guide-lede" },
				inline(
					"This ledger is a JSON document with stable row ids. A program reads it at the address below, writes it through the API, or connects to it as an MCP server — and a key lets it in without the URL.",
				),
			),
		);

		const addr = section("Addresses", "The URL is the whole key: whoever holds it holds the board. Give a program the JSON address to read, the OpenAPI document to learn every call, or the MCP address to act.");
		addr.body.append(
			addressRow("JSON", jsonUrl, "the board as a document — rows in desire order, with `address`, `lineage`, chips, and claims"),
			addressRow("OpenAPI", openapiUrl, "every endpoint, described; paste it into a GPT Action or any client that reads a spec"),
			addressRow("MCP", mcpUrl, "`Authorization: Bearer` a key (or this board's id); tools for reading, adding, applying, dropping, explaining"),
			stage("read it", [`curl -s ${jsonUrl} | jq '.entries[] | [.desire, .status, .source]'`], "guide-stage agents-stage"),
		);

		const keys = section(
			"Keys",
			"A key is this URL narrowed: it opens only this board, only for the scopes you tick, and it can never delete the board or mint another key. Hand it to an agent instead of the URL; its writes are signed with the label in the activity below.",
		);
		keysHost = el("div", { class: "agents-list" });
		reveal = el("div", { class: "agents-reveal" });
		reveal.hidden = true;
		keys.body.append(keysHost, renderMintForm(), reveal);

		const hooks = section("Webhooks", "A listener the board tells the moment rows move: one signed POST per change, carrying the events with the row before and after, never the board's id.");
		hooksHost = el("div", { class: "agents-list" });
		hooks.body.append(hooksHost, renderHookForm());

		const activity = section("Recent activity", "Who did what — a person with the URL, the CLI, or a key by its label — with the columns before and after. The last thousand events are kept.");
		activityHost = el("div", { class: "agents-list" });
		activity.body.append(activityHost);

		art.append(
			addr.root,
			keys.root,
			hooks.root,
			activity.root,
			el(
				"p",
				{ class: "guide-links" },
				el("a", { class: "spell-doc", href: "/docs/board/", target: "_blank", rel: "noreferrer" }, "Docs → The board, for agents"),
				el("span", { class: "guide-sep", "aria-hidden": "true" }, "·"),
				el("a", { class: "spell-doc", href: "/docs/board/api/", target: "_blank", rel: "noreferrer" }, "API reference"),
				el("span", { class: "guide-sep", "aria-hidden": "true" }, "·"),
				el("a", { class: "spell-doc", href: "/docs/board/agents/", target: "_blank", rel: "noreferrer" }, "Agents & MCP"),
			),
		);

		const scroll = el("div", { class: "guide-scroll" }, art);
		d.append(el("div", { class: "guide-frame" }, bar, scroll));
		d.addEventListener("click", (ev) => {
			if (ev.target === d) d.close();
		});
		d.addEventListener("close", () => {
			if (reveal) {
				reveal.replaceChildren();
				reveal.hidden = true;
			}
			if (opener?.isConnected) opener.focus();
			opener = null;
		});
		document.body.append(d);
	}

	return {
		open(from = null) {
			if (!dlg) build();
			opener = from ?? (document.activeElement as HTMLElement | null);
			if (!dlg!.open) dlg!.showModal();
			dlg!.querySelector<HTMLElement>(".guide-scroll")!.scrollTop = 0;
			dlg!.querySelector<HTMLElement>(".agents-card")?.focus({ preventScroll: true });
			void refresh();
		},
		close() {
			dlg?.close();
		},
	};
}

export { plural };

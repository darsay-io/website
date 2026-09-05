/**
 * The dropped rows dialog: what the toolbar's "N dropped" opens. A dropped
 * row is off the ledger, not off the board — it left the list and the
 * catalog, and Restore brings it back exactly as it was. Everything from
 * the API is rendered with textContent.
 */
import { el, toast } from "./dom.ts";
import { plural, relativeTime } from "./format.ts";
import { repoName } from "./lenses.ts";

export type DroppedContext = {
	boardId: string;
	api: (path: string, init?: RequestInit) => Promise<unknown>;
	/** A row came back: repaint the board. */
	onChange: () => Promise<void>;
	humanError: (msg: string) => string;
	/** The dialog closed after a restore: show that row on the ledger. */
	reveal: (rowId: number) => void;
	/** Where focus lands when the dialog closes and its opener was repainted away. */
	fallbackFocus: () => HTMLElement | null;
};

export type Dropped = { open: (from?: HTMLElement | null) => void; close: () => void };

type DroppedRow = { id: number; source: string; note: string | null; dropped: string | null; desire: number | null };

export function createDropped(ctx: DroppedContext): Dropped {
	let dlg: HTMLDialogElement | null = null;
	let list: HTMLElement | null = null;
	let pos: HTMLElement | null = null;
	let opener: HTMLElement | null = null;
	let lastRestored: number | null = null;

	const base = `/api/boards/${ctx.boardId}`;

	function fail(err: unknown) {
		toast(ctx.humanError(err instanceof Error ? err.message : "failed"), "error");
	}

	async function paint(): Promise<number> {
		if (!list || !pos) return 0;
		let rows: DroppedRow[];
		try {
			rows = ((await ctx.api(`${base}/entries?dropped=only`)) as { entries: DroppedRow[] }).entries;
		} catch (err) {
			fail(err);
			return 0;
		}
		list.replaceChildren();
		pos.textContent = rows.length ? `${plural(rows.length, "row")} off the ledger` : "";
		if (!rows.length) {
			list.append(el("p", { class: "dropped-empty" }, "Nothing is dropped. Every row is on the ledger."));
			return 0;
		}
		for (const r of rows) {
			const restore = el("button", { type: "button", class: "btn compact secondary" }, "Restore");
			restore.addEventListener("click", async () => {
				restore.disabled = true;
				try {
					await ctx.api(`${base}/entries/${r.id}/restore`, { method: "POST" });
					lastRestored = r.id;
					toast(`Restored ${repoName(r.source)}`);
					await ctx.onChange();
					if ((await paint()) === 0) dlg?.close();
				} catch (err) {
					fail(err);
					restore.disabled = false;
				}
			});
			const row = el(
				"div",
				{ class: "dropped-row" },
				el("code", { class: "dropped-src" }, repoName(r.source)),
				el("span", { class: "dropped-when muted" }, r.dropped ? `dropped ${relativeTime(r.dropped)}` : "dropped"),
				restore,
			);
			if (r.note) row.append(el("p", { class: "dropped-note" }, r.note));
			list.append(row);
		}
		return rows.length;
	}

	function build() {
		const d = el("dialog", { class: "guide dropped", "aria-labelledby": "dropped-title" });
		dlg = d;
		const close = el("button", { type: "button", class: "guide-close", "aria-label": "Close" }, "×");
		close.addEventListener("click", () => d.close());
		pos = el("span", { class: "guide-pos" });
		const bar = el("header", { class: "guide-bar" }, el("span", { class: "guide-kicker" }, el("span", { "aria-hidden": "true" }, "✦ "), "Dropped rows"), pos, close);

		list = el("div", { class: "dropped-list" });
		const art = el(
			"article",
			{ class: "guide-card dropped-card", tabindex: "-1" },
			el("p", { class: "guide-group" }, "The ledger", el("span", { class: "guide-group-note" }, "off the ledger, not off the board")),
			el("h2", { class: "guide-title", id: "dropped-title" }, "Dropped is not gone"),
			el(
				"p",
				{ class: "guide-lede" },
				"A dropped row leaves the ledger and the catalog, so the CLI stops asking for it; vaults are untouched. Restore brings it back exactly as it was.",
			),
			list,
		);

		const scroll = el("div", { class: "guide-scroll" }, art);
		d.append(el("div", { class: "guide-frame" }, bar, scroll));
		d.addEventListener("click", (ev) => {
			if (ev.target === d) d.close();
		});
		d.addEventListener("close", () => {
			const home = opener?.isConnected ? opener : ctx.fallbackFocus();
			home?.focus();
			opener = null;
			if (lastRestored !== null) {
				ctx.reveal(lastRestored);
				lastRestored = null;
			}
		});
		document.body.append(d);
	}

	return {
		open(from = null) {
			if (!dlg) build();
			opener = from ?? (document.activeElement as HTMLElement | null);
			lastRestored = null;
			if (!dlg!.open) dlg!.showModal();
			dlg!.querySelector<HTMLElement>(".guide-scroll")!.scrollTop = 0;
			dlg!.querySelector<HTMLElement>(".dropped-card")?.focus({ preventScroll: true });
			void paint();
		},
		close() {
			dlg?.close();
		},
	};
}

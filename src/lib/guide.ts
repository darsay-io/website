/**
 * The field guide dialog: one teaching card at a time, a deck strip to jump
 * between them, arrows to turn pages, and a "show on the board" button that
 * applies the lens the card explains. Content comes from primer.ts; nothing
 * here is user text. Opened from a row, every card also applies its lesson
 * to that row (rownote.ts) until the guide closes.
 */
import { el, inline, roman, stage } from "./dom.ts";
import { LENS_BY_KEY, repoName, type LensKey } from "./lenses.ts";
import { PRIMER, PRIMER_BY_KEY, primerIndex, type PrimerCard, type PrimerKey } from "./primer.ts";
import { rowNote, type RowFacts } from "./rownote.ts";

export type GuideContext = {
	/** Rows on the board a lens currently matches. */
	lensCount: (key: LensKey) => number;
	/** Make that lens the active one and scroll the ledger into view. */
	showLens: (key: LensKey) => void;
};

export type Guide = {
	/** Open at a card; with a row, every card applies its lesson to that row until the guide closes. */
	open: (key?: PrimerKey, opener?: HTMLElement | null, row?: RowFacts | null) => void;
	close: () => void;
};

/** "MoE" stays MoE; "In flight" becomes in flight. */
function lensWord(label: string): string {
	return /[A-Z]/.test(label.slice(1)) ? label : label.toLowerCase();
}

export function createGuide(ctx: GuideContext): Guide {
	let dlg: HTMLDialogElement | null = null;
	let cardHost: HTMLElement | null = null;
	let pos: HTMLElement | null = null;
	let prev: HTMLButtonElement | null = null;
	let next: HTMLButtonElement | null = null;
	let deck: HTMLElement | null = null;
	let current: PrimerKey = PRIMER[0].key;
	let opener: HTMLElement | null = null;
	let row: RowFacts | null = null;
	let rowTag: HTMLElement | null = null;

	function build() {
		const d = el("dialog", { class: "guide", "aria-labelledby": "guide-title" });
		dlg = d;
		const close = el("button", { type: "button", class: "guide-close", "aria-label": "Close the field guide" }, "×");
		close.addEventListener("click", () => d.close());
		pos = el("span", { class: "guide-pos" });
		rowTag = el("span", { class: "guide-row-tag" });
		const bar = el(
			"header",
			{ class: "guide-bar" },
			el("span", { class: "guide-kicker" }, el("span", { "aria-hidden": "true" }, "✦ "), "Field guide"),
			rowTag,
			pos,
			close,
		);
		cardHost = el("div", { class: "guide-scroll" });
		prev = el("button", { type: "button", class: "guide-turn guide-prev" });
		next = el("button", { type: "button", class: "guide-turn guide-next" });
		prev.addEventListener("click", () => turn(-1));
		next.addEventListener("click", () => turn(1));
		deck = el("ol", { class: "guide-deck", "aria-label": "All cards" });
		PRIMER.forEach((c, i) => {
			const b = el(
				"button",
				{ type: "button", class: "guide-deck-btn", title: c.title, "aria-label": `${roman(i)} — ${c.title}` },
				roman(i),
			);
			b.addEventListener("click", () => show(c.key));
			deck!.append(el("li", {}, b));
		});
		const nav = el("footer", { class: "guide-nav" }, prev, deck, next);
		const hint = el(
			"p",
			{ class: "guide-keys", "aria-hidden": "true" },
			el("kbd", {}, "←"),
			" ",
			el("kbd", {}, "→"),
			" turn the page · ",
			el("kbd", {}, "esc"),
			" closes · ",
			el("kbd", {}, "?"),
			" opens from the board",
		);
		d.append(el("div", { class: "guide-frame" }, bar, cardHost, nav, hint));
		d.addEventListener("click", (ev) => {
			if (ev.target === d) d.close();
		});
		d.addEventListener("keydown", (ev) => {
			const t = ev.target as HTMLElement | null;
			if (t?.closest(".guide-table-wrap, input, textarea")) return;
			if (ev.key === "ArrowRight") {
				ev.preventDefault();
				turn(1);
			} else if (ev.key === "ArrowLeft") {
				ev.preventDefault();
				turn(-1);
			}
		});
		d.addEventListener("close", () => {
			if (opener?.isConnected) opener.focus();
			opener = null;
			row = null;
		});
		document.body.append(d);
	}

	function turn(delta: number) {
		const i = primerIndex(current);
		const j = (i + delta + PRIMER.length) % PRIMER.length;
		show(PRIMER[j].key);
	}

	function renderCard(c: PrimerCard, i: number): HTMLElement {
		const art = el("article", { class: "guide-card", tabindex: "-1" });
		const group = el("p", { class: "guide-group" }, el("span", { class: "guide-num" }, roman(i)), c.group);
		if (c.lens && LENS_BY_KEY[c.lens].fromName) {
			group.append(el("span", { class: "guide-group-note" }, "read from the repo name, not the bytes"));
		}
		art.append(group, el("h2", { class: "guide-title", id: "guide-title" }, c.title), el("p", { class: "guide-lede" }, inline(c.lede)));
		const body = el("div", { class: "guide-body" });
		for (const p of c.body) body.append(el("p", {}, inline(p)));
		art.append(body);
		if (c.table) {
			const table = el("table", { class: "guide-table" });
			const thead = el("thead", {});
			const hr = el("tr", {});
			for (const h of c.table.head) hr.append(el("th", { scope: "col" }, h));
			thead.append(hr);
			const tbody = el("tbody", {});
			for (const r of c.table.rows) {
				const tr = el("tr", {});
				r.forEach((cell, ci) => tr.append(el(ci === 0 ? "th" : "td", ci === 0 ? { scope: "row" } : {}, cell)));
				tbody.append(tr);
			}
			table.append(thead, tbody);
			art.append(el("div", { class: "guide-table-wrap", tabindex: "0" }, table));
		}
		if (c.cmd) art.append(stage(c.cmd.label, c.cmd.lines, "guide-stage"));
		const note = row ? rowNote(c.key, row) : null;
		if (row && note) {
			art.append(
				el(
					"aside",
					{ class: "guide-row" },
					el(
						"p",
						{ class: "guide-row-k" },
						el("span", { "aria-hidden": "true" }, "✦ "),
						"On this row",
						el("span", { class: "guide-row-src" }, repoName(row.source)),
					),
					el("p", { class: "guide-row-t" }, inline(note)),
				),
			);
		}
		art.append(el("p", { class: "guide-collect" }, el("span", { class: "guide-collect-k" }, "Collect"), inline(c.collect)));
		const links = el("p", { class: "guide-links" });
		if (c.doc) links.append(el("a", { class: "spell-doc", href: c.doc.href, target: "_blank", rel: "noreferrer" }, c.doc.label));
		if (c.link) {
			if (links.childNodes.length) links.append(el("span", { class: "guide-sep", "aria-hidden": "true" }, "·"));
			links.append(
				el("a", { class: "spell-doc guide-ext", href: c.link.href, target: "_blank", rel: "noreferrer" }, c.link.label, " ↗"),
			);
		}
		if (links.childNodes.length) art.append(links);

		const foot = el("div", { class: "guide-foot" });
		if (c.lens) {
			const lens = LENS_BY_KEY[c.lens];
			const n = ctx.lensCount(c.lens);
			if (n > 0) {
				const label =
					n === 1 ? `Show the one ${lens.noun} row on the board` : n === 2 ? `Show both ${lens.noun} rows` : `Show all ${n} ${lens.noun} rows`;
				const show = el("button", { type: "button", class: "btn compact guide-show" }, label);
				show.addEventListener("click", () => {
					dlg?.close();
					ctx.showLens(c.lens!);
				});
				foot.append(show);
			} else {
				foot.append(
					el(
						"p",
						{ class: "guide-none" },
						`None on this board yet — the ${lensWord(lens.label)} lens appears above the list as soon as a row qualifies.`,
					),
				);
			}
		}
		if (c.related.length) {
			const rel = el("div", { class: "guide-related" }, el("span", { class: "guide-related-k" }, "See also"));
			for (const r of c.related) {
				const card = PRIMER_BY_KEY[r];
				const b = el("button", { type: "button", class: "guide-rel" }, card.title);
				b.addEventListener("click", () => show(r));
				rel.append(b);
			}
			foot.append(rel);
		}
		art.append(foot);
		return art;
	}

	function show(key: PrimerKey) {
		if (!dlg || !cardHost || !pos || !prev || !next || !deck) return;
		current = key;
		const i = primerIndex(key);
		const c = PRIMER[i];
		pos.textContent = `${roman(i)} of ${roman(PRIMER.length - 1)}`;
		if (rowTag) {
			rowTag.replaceChildren();
			if (row) rowTag.append(el("span", { class: "guide-row-tag-k" }, "through "), el("code", {}, repoName(row.source)));
		}
		const card = renderCard(c, i);
		cardHost.replaceChildren(card);
		cardHost.scrollTop = 0;
		const before = PRIMER[(i - 1 + PRIMER.length) % PRIMER.length];
		const after = PRIMER[(i + 1) % PRIMER.length];
		prev.replaceChildren(el("span", { "aria-hidden": "true" }, "← "), el("span", { class: "guide-turn-t" }, before.title));
		prev.setAttribute("aria-label", `Previous: ${before.title}`);
		next.replaceChildren(el("span", { class: "guide-turn-t" }, after.title), el("span", { "aria-hidden": "true" }, " →"));
		next.setAttribute("aria-label", `Next: ${after.title}`);
		deck.querySelectorAll("button").forEach((b, bi) => {
			if (bi === i) b.setAttribute("aria-current", "true");
			else b.removeAttribute("aria-current");
		});
		deck.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
		card.focus({ preventScroll: true });
	}

	return {
		open(key = PRIMER[0].key, from = null, forRow = null) {
			if (!dlg) build();
			row = forRow;
			opener = from ?? (document.activeElement as HTMLElement | null);
			if (!dlg!.open) dlg!.showModal();
			show(key);
		},
		close() {
			dlg?.close();
		},
	};
}

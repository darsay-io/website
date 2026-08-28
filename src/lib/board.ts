import { hfUrlFromCanonical } from "../worker/sources.ts";

type Entry = {
	id: number;
	source: string;
	revision: string | null;
	include: string[] | null;
	desire: number | null;
	note: string | null;
	status: "want" | "have";
	holders: string;
	added: string;
	payload_bytes: number | null;
};

type Board = {
	id: string;
	catalog_id: string;
	title: string;
	curator: string | null;
	note: string | null;
	created: string;
	updated: string;
	entries: Entry[];
};

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") n.className = v;
		else n.setAttribute(k, v);
	}
	for (const kid of kids) n.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
	return n;
}

function humanSize(n: number | null): string {
	if (n === null || n === undefined) return "—";
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

async function api(path: string, init?: RequestInit) {
	const res = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = { error: text };
	}
	if (!res.ok) {
		const err = (body as { error?: string })?.error || res.statusText;
		throw new Error(err);
	}
	return body;
}

export function mountCreate(root: HTMLElement) {
	const title = el("input", {
		type: "text",
		placeholder: "Summer 2026",
		maxlength: "120",
		id: "board-title",
	});
	const password = el("input", {
		type: "password",
		placeholder: "Shared create password",
		autocomplete: "off",
		spellcheck: "false",
		id: "board-password",
	});
	const status = el("p", { class: "muted" });
	const urlBox = el("p", { class: "board-url" });
	const copyBtn = el("button", { type: "button", class: "btn secondary" }, "Copy URL");
	const ackBox = el("input", { type: "checkbox" });
	const ack = el("label", { class: "ack" }, ackBox, el("span", {}, "I have copied this URL. Losing it loses the board."));
	const go = el("a", { href: "#", class: "btn" }, "Open board");
	go.hidden = true;
	const result = el("div", { class: "create-result" }, urlBox, copyBtn, ack, go);
	result.hidden = true;

	const form = el("form", { class: "create-form" });
	const submit = el("button", { type: "submit", class: "btn" }, "Create a board");
	form.append(
		el("label", { class: "field" }, el("span", {}, "Title"), title),
		el("label", { class: "field" }, el("span", {}, "Create password"), password),
		submit,
		status,
		result,
	);
	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		submit.disabled = true;
		status.textContent = "Creating…";
		try {
			const body = (await api("/api/boards", {
				method: "POST",
				body: JSON.stringify({ title: title.value, password: password.value }),
			})) as { url: string };
			urlBox.textContent = body.url;
			result.hidden = false;
			copyBtn.onclick = async () => {
				try {
					await navigator.clipboard.writeText(body.url);
				} catch {
					/* user can select the URL */
				}
			};
			ackBox.addEventListener("change", () => {
				go.hidden = !ackBox.checked;
				go.setAttribute("href", body.url);
			});
			go.hidden = true;
			status.textContent = "Copy this URL. It is the only way back.";
			submit.hidden = true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : "failed";
			status.textContent =
				msg === "unauthorized" ? "Wrong create password." : msg === "create_disabled" ? "Board create is off." : msg;
			submit.disabled = false;
		}
	});
	root.append(form);
}

type SortKey = "source" | "desire" | "size" | "status";

export function compareEntries(a: Entry, b: Entry, key: SortKey, dir: "asc" | "desc"): number {
	let cmp = 0;
	if (key === "desire" || key === "size") {
		const av = key === "desire" ? a.desire : a.payload_bytes;
		const bv = key === "desire" ? b.desire : b.payload_bytes;
		if (av === null && bv === null) cmp = 0;
		else if (av === null) return 1;
		else if (bv === null) return -1;
		else cmp = av - bv;
	} else if (key === "source") {
		cmp = a.source.localeCompare(b.source);
	} else {
		cmp = (a.status === "have" ? 1 : 0) - (b.status === "have" ? 1 : 0);
	}
	if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
	return a.id - b.id;
}

export async function mountBoard(root: HTMLElement, id: string) {
	root.replaceChildren(el("p", {}, "Loading…"));
	let board: Board;
	try {
		board = (await api(`/api/boards/${id}`)) as Board;
	} catch {
		root.replaceChildren(el("p", {}, "Board not found. Check the URL."));
		return;
	}

	let sortKey: SortKey = "desire";
	let sortDir: "asc" | "desc" = "desc";
	let message = "";

	function field(label: string, value: string, onSave: (v: string) => void) {
		const input = el("input", { type: "text", value });
		input.addEventListener("change", () => onSave(input.value));
		return el("label", { class: "meta-field" }, el("span", {}, label), input);
	}

	async function patchBoard(body: Record<string, unknown>) {
		try {
			await api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify(body) });
			message = "";
			await reload();
		} catch (e) {
			message = e instanceof Error ? e.message : "failed";
			render();
		}
	}

	async function patchEntry(eid: number, body: Record<string, unknown>, reloadAfter = true) {
		try {
			await api(`/api/boards/${id}/entries/${eid}`, { method: "PATCH", body: JSON.stringify(body) });
			message = "";
			if (reloadAfter) await reload();
		} catch (e) {
			message = e instanceof Error ? e.message : "failed";
			render();
		}
	}

	async function reload() {
		board = (await api(`/api/boards/${id}`)) as Board;
		render();
	}

	function render() {
		const header = el("header", { class: "board-head" });
		header.append(
			field("Title", board.title || "", (v) => patchBoard({ title: v })),
			field("Curator", board.curator || "", (v) => patchBoard({ curator: v })),
			field("Note", board.note || "", (v) => patchBoard({ note: v })),
		);
		const actions = el("div", { class: "board-actions" });
		const copy = el("button", { type: "button", class: "btn secondary" }, "Copy URL");
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(location.href);
			} catch {
				/* ignore */
			}
		});
		const dl = el("button", { type: "button", class: "btn secondary" }, "Download catalog.json");
		dl.addEventListener("click", async () => {
			const res = await fetch(`/api/boards/${id}/catalog.json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (!res.ok) return;
			const blob = await res.blob();
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = `${board.catalog_id}.json`;
			a.rel = "noreferrer";
			a.click();
			URL.revokeObjectURL(a.href);
		});
		const del = el("button", { type: "button", class: "btn danger" }, "Delete board");
		del.addEventListener("click", async () => {
			const typed = prompt('Type "delete" to destroy this board');
			if (typed !== "delete") return;
			await api(`/api/boards/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: "delete" }) });
			location.href = "/";
		});
		actions.append(copy, dl, del);
		header.append(
			el("p", { class: "muted" }, `catalog id ${board.catalog_id} · created ${board.created} · updated ${board.updated}`),
			actions,
		);
		if (message) header.append(el("p", { class: "flash" }, message));

		const table = el("table", { class: "board-table" });
		const thead = el("thead");
		const sortCols: { label: string; key: SortKey | null }[] = [
			{ label: "Source", key: "source" },
			{ label: "Desire", key: "desire" },
			{ label: "Size", key: "size" },
			{ label: "Have", key: "status" },
			{ label: "Who", key: null },
			{ label: "Note", key: null },
			{ label: "", key: null },
		];
		const headRow = el("tr");
		for (const col of sortCols) {
			if (!col.key) {
				headRow.append(el("th", {}, col.label));
				continue;
			}
			const key = col.key;
			const mark = sortKey === key ? (sortDir === "desc" ? " ▾" : " ▴") : "";
			const btn = el("button", { type: "button", class: "th-sort" }, col.label + mark);
			btn.addEventListener("click", () => {
				if (sortKey === key) sortDir = sortDir === "desc" ? "asc" : "desc";
				else {
					sortKey = key;
					sortDir = key === "source" ? "asc" : "desc";
				}
				render();
			});
			headRow.append(el("th", {}, btn));
		}
		thead.append(headRow);
		const tbody = el("tbody");
		const rows = [...board.entries].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
		for (const e of rows) {
			const tr = el("tr");
			const srcCell = el("td");
			const href = hfUrlFromCanonical(e.source);
			if (href) {
				const a = el("a", { href, rel: "noreferrer", target: "_blank" }, e.source);
				srcCell.append(a);
			} else {
				srcCell.append(e.source);
			}
			if (e.revision) srcCell.append(el("div", { class: "muted" }, e.revision));
			if (e.include?.length) srcCell.append(el("div", { class: "muted" }, e.include.join(", ")));

			const desire = el("input", { type: "number", min: "1", max: "9", value: e.desire ? String(e.desire) : "" });
			desire.addEventListener("change", async () => {
				const v = desire.value === "" ? null : Number(desire.value);
				await patchEntry(e.id, { desire: v });
			});

			const have = el("input", { type: "checkbox" });
			if (e.status === "have") have.checked = true;
			have.addEventListener("change", async () => {
				await patchEntry(e.id, { status: have.checked ? "have" : "want" });
			});

			const who = el("input", { type: "text", placeholder: "Maya, USB in Berlin", value: e.holders || "" });
			who.addEventListener("change", async () => {
				await patchEntry(e.id, { holders: who.value }, false);
			});

			const note = el("input", { type: "text", value: e.note || "" });
			note.addEventListener("change", async () => {
				await patchEntry(e.id, { note: note.value }, false);
			});

			const rm = el("button", { type: "button", class: "btn secondary" }, "Drop");
			rm.addEventListener("click", async () => {
				if (!confirm("Drop this row?")) return;
				await api(`/api/boards/${id}/entries/${e.id}`, { method: "DELETE" });
				await reload();
			});

			tr.append(
				srcCell,
				el("td", {}, desire),
				el("td", {}, humanSize(e.payload_bytes)),
				el("td", {}, have),
				el("td", {}, who),
				el("td", {}, note),
				el("td", {}, rm),
			);
			tbody.append(tr);
		}
		table.append(thead, tbody);
		const wrap = el("div", { class: "board-wrap" }, table);

		const add = el("form", { class: "add-row" });
		const source = el("input", { type: "text", placeholder: "huggingface:Qwen/Qwen3-0.6B", required: "true" });
		const d = el("input", { type: "number", min: "1", max: "9", placeholder: "desire" });
		const rev = el("input", { type: "text", placeholder: "revision (optional)", maxlength: "64" });
		const advanced = el("details");
		const inc = el("input", { type: "text", placeholder: "include globs, comma-separated" });
		advanced.append(el("summary", {}, "subset / include"), inc);
		const addBtn = el("button", { type: "submit", class: "btn" }, "Add source");
		const addErr = el("p", { class: "muted" });
		add.append(source, d, rev, advanced, addBtn, addErr);
		add.addEventListener("submit", async (ev) => {
			ev.preventDefault();
			addErr.textContent = "";
			const include = inc.value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			try {
				await api(`/api/boards/${id}/entries`, {
					method: "POST",
					body: JSON.stringify({
						source: source.value,
						desire: d.value === "" ? null : Number(d.value),
						revision: rev.value.trim() || null,
						include: include.length ? include : null,
					}),
				});
				source.value = "";
				rev.value = "";
				await reload();
			} catch (err) {
				addErr.textContent = err instanceof Error ? err.message : "failed";
			}
		});

		root.replaceChildren(header, wrap, add);
	}

	render();
}

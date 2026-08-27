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
	const title = el("input", { type: "text", placeholder: "Board title (e.g. Summer 2026)", maxlength: "120" });
	const status = el("p", { class: "muted" });
	const urlBox = el("p", { class: "board-url" });
	const copyBtn = el("button", { type: "button" }, "Copy URL");
	copyBtn.hidden = true;
	const ack = el("label", { class: "ack" });
	const ackBox = el("input", { type: "checkbox" });
	ack.append(ackBox, document.createTextNode(" I have copied this URL. Losing it loses the board."));
	ack.hidden = true;
	const go = el("a", { href: "#", class: "btn" }, "Open board");
	go.hidden = true;

	const form = el("form", { class: "create-form" });
	const submit = el("button", { type: "submit" }, "Create a board");
	form.append(title, submit, status, urlBox, copyBtn, ack, go);
	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		submit.disabled = true;
		status.textContent = "Creating…";
		try {
			const body = (await api("/api/boards", {
				method: "POST",
				body: JSON.stringify({ title: title.value }),
			})) as { url: string };
			urlBox.textContent = body.url;
			copyBtn.hidden = false;
			ack.hidden = false;
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
			status.textContent = "Copy this URL. It is the only way back.";
		} catch (e) {
			status.textContent = e instanceof Error ? e.message : "failed";
			submit.disabled = false;
		}
	});
	root.append(form);
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

	function field(label: string, value: string, onSave: (v: string) => void) {
		const input = el("input", { type: "text", value });
		input.addEventListener("change", () => onSave(input.value));
		return el("label", { class: "meta-field" }, el("span", {}, label), input);
	}

	async function patchBoard(body: Record<string, unknown>) {
		await api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify(body) });
		await reload();
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
		const copy = el("button", { type: "button" }, "Copy URL");
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(location.href);
			} catch {
				/* ignore */
			}
		});
		const dl = el("button", { type: "button" }, "Download catalog.json");
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
		const del = el("button", { type: "button", class: "danger" }, "Delete board");
		del.addEventListener("click", async () => {
			const typed = prompt('Type "delete" to destroy this board');
			if (typed !== "delete") return;
			await api(`/api/boards/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: "delete" }) });
			location.href = "/";
		});
		actions.append(copy, dl, del);
		header.append(el("p", { class: "muted" }, `catalog id ${board.catalog_id} · updated ${board.updated}`), actions);

		const table = el("table", { class: "board-table" });
		const thead = el("thead");
		thead.append(
			el(
				"tr",
				{},
				...["Source", "Desire", "Size", "Have", "Who", "Note", ""].map((h) => el("th", {}, h)),
			),
		);
		const tbody = el("tbody");
		for (const e of board.entries) {
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
				await api(`/api/boards/${id}/entries/${e.id}`, {
					method: "PATCH",
					body: JSON.stringify({ desire: v }),
				});
				await reload();
			});

			const have = el("input", { type: "checkbox" });
			if (e.status === "have") have.checked = true;
			have.addEventListener("change", async () => {
				await api(`/api/boards/${id}/entries/${e.id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: have.checked ? "have" : "want" }),
				});
				await reload();
			});

			const who = el("input", { type: "text", placeholder: "Maya, USB in Berlin", value: e.holders || "" });
			who.addEventListener("change", async () => {
				await api(`/api/boards/${id}/entries/${e.id}`, {
					method: "PATCH",
					body: JSON.stringify({ holders: who.value }),
				});
			});

			const note = el("input", { type: "text", value: e.note || "" });
			note.addEventListener("change", async () => {
				await api(`/api/boards/${id}/entries/${e.id}`, {
					method: "PATCH",
					body: JSON.stringify({ note: note.value }),
				});
			});

			const rm = el("button", { type: "button" }, "Drop");
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

		const add = el("form", { class: "add-row" });
		const source = el("input", { type: "text", placeholder: "huggingface:Qwen/Qwen3-0.6B", required: "true" });
		const d = el("input", { type: "number", min: "1", max: "9", placeholder: "desire" });
		const advanced = el("details");
		const inc = el("input", { type: "text", placeholder: "include globs, comma-separated" });
		advanced.append(el("summary", {}, "subset / include"), inc);
		const addBtn = el("button", { type: "submit" }, "Add source");
		const addErr = el("p", { class: "muted" });
		add.append(source, d, advanced, addBtn, addErr);
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
						include: include.length ? include : null,
					}),
				});
				source.value = "";
				await reload();
			} catch (err) {
				addErr.textContent = err instanceof Error ? err.message : "failed";
			}
		});

		root.replaceChildren(header, table, add);
	}

	render();
}

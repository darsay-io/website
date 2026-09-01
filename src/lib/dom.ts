/** Small DOM helpers shared by the board, the recipe cards, and the field guide. Text only; never HTML. */

export function el<K extends keyof HTMLElementTagNameMap>(
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

export const ROMAN = [
	"I",
	"II",
	"III",
	"IV",
	"V",
	"VI",
	"VII",
	"VIII",
	"IX",
	"X",
	"XI",
	"XII",
	"XIII",
	"XIV",
	"XV",
	"XVI",
	"XVII",
	"XVIII",
	"XIX",
	"XX",
];

export function roman(i: number): string {
	return ROMAN[i] ?? String(i + 1);
}

export function termDots(): HTMLElement {
	return el("span", { class: "cmd-dots", "aria-hidden": "true" }, el("span"), el("span"), el("span"));
}

/** Shell lines as text nodes; a trailing `# comment` gets a dimmer span. Never HTML. */
export function codeLines(lines: string[]): HTMLElement {
	const code = el("code", { class: "cmd-text" });
	lines.forEach((line, i) => {
		if (i > 0) code.append("\n");
		const m = /^(\s*)(#.*)$/.exec(line) ?? /^(.*?\S)(\s+#.*)$/.exec(line);
		if (m) {
			if (m[1]) code.append(m[1]);
			code.append(el("span", { class: "cmd-comment" }, m[2]));
		} else if (line) {
			code.append(line);
		}
	});
	return code;
}

/**
 * Prose with `backtick` spans rendered as <code>. For static, authored copy
 * only (the field guide); user text always goes through textContent.
 */
export function inline(text: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	const parts = text.split("`");
	parts.forEach((part, i) => {
		if (!part) return;
		if (i % 2 === 1) frag.append(el("code", {}, part));
		else emphasis(part, frag);
	});
	return frag;
}

/** `**strong**` and `*em*` inside a plain-text segment. */
function emphasis(text: string, into: DocumentFragment) {
	const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > last) into.append(document.createTextNode(text.slice(last, m.index)));
		into.append(m[1] !== undefined ? el("strong", {}, m[1]) : el("em", {}, m[2]));
		last = re.lastIndex;
	}
	if (last < text.length) into.append(document.createTextNode(text.slice(last)));
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export function flashCopied(btn: HTMLButtonElement, label = "Copied ✓", ms = 1600) {
	const prev = btn.textContent;
	btn.textContent = label;
	btn.classList.add("is-copied");
	window.setTimeout(() => {
		btn.textContent = prev;
		btn.classList.remove("is-copied");
	}, ms);
}

export function selectContents(node: Node) {
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	range.selectNodeContents(node);
	sel.removeAllRanges();
	sel.addRange(range);
}

export function isMac(): boolean {
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Copy; where the clipboard is unavailable, select the text and name the key instead. */
export async function copyOrSelect(btn: HTMLButtonElement, text: string, node: Node) {
	if (await copyText(text)) {
		flashCopied(btn);
		return;
	}
	selectContents(node);
	flashCopied(btn, isMac() ? "Selected · ⌘C" : "Selected · Ctrl+C", 2400);
}

/** A terminal stage: three dots, a label, a copy button, the lines. */
export function stage(label: string, lines: string[], extraClass = ""): HTMLElement {
	const text = lines.join("\n");
	const code = codeLines(lines);
	const copy = el("button", { type: "button", class: "btn compact cmd-copy" }, "Copy");
	copy.addEventListener("click", () => void copyOrSelect(copy, text, code));
	return el(
		"div",
		{ class: `cmd-stage${extraClass ? ` ${extraClass}` : ""}` },
		el("div", { class: "cmd-chrome" }, termDots(), el("span", { class: "cmd-label" }, label), copy),
		el("pre", {}, code),
	);
}

export const reducedMotion = () =>
	typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let toastRoot: HTMLElement | null = null;
let toastTimer = 0;

/** One quiet line at the bottom of the viewport: saved, copied, failed. */
export function toast(message: string, kind: "ok" | "error" = "ok") {
	if (!toastRoot) {
		toastRoot = el("div", { class: "toast", role: "status", "aria-live": "polite" });
		document.body.append(toastRoot);
	}
	toastRoot.textContent = message;
	toastRoot.className = `toast is-${kind} is-shown`;
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => toastRoot?.classList.remove("is-shown"), kind === "error" ? 4200 : 1800);
}

/**
 * A styled confirm in place of window.confirm. `typed` demands the word be
 * typed before the button arms. Resolves true only on the primary button.
 */
export function confirmDialog(opts: {
	title: string;
	body: string;
	action: string;
	danger?: boolean;
	typed?: string;
}): Promise<boolean> {
	return new Promise((resolve) => {
		const dlg = el("dialog", { class: "confirm" });
		const ok = el("button", { type: "button", class: opts.danger ? "btn danger" : "btn" }, opts.action);
		const cancel = el("button", { type: "button", class: "btn secondary" }, "Keep it");
		const form = el("div", { class: "confirm-body" }, el("h3", {}, opts.title), el("p", {}, opts.body));
		let input: HTMLInputElement | null = null;
		if (opts.typed) {
			ok.disabled = true;
			input = el("input", {
				type: "text",
				autocomplete: "off",
				spellcheck: "false",
				placeholder: opts.typed,
				"aria-label": `Type ${opts.typed} to confirm`,
			});
			input.addEventListener("input", () => {
				ok.disabled = input!.value.trim() !== opts.typed;
			});
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" && !ok.disabled) ok.click();
			});
			form.append(el("label", { class: "confirm-typed" }, el("span", {}, `Type “${opts.typed}” to confirm`), input));
		}
		let result = false;
		ok.addEventListener("click", () => {
			result = true;
			dlg.close();
		});
		cancel.addEventListener("click", () => dlg.close());
		dlg.addEventListener("close", () => {
			dlg.remove();
			resolve(result);
		});
		dlg.addEventListener("click", (ev) => {
			if (ev.target === dlg) dlg.close();
		});
		dlg.append(form, el("div", { class: "confirm-actions" }, cancel, ok));
		document.body.append(dlg);
		dlg.showModal();
		(input ?? cancel).focus();
	});
}

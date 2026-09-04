import { el } from "./dom.ts";
import { hfUrlFromCanonical } from "../worker/sources.ts";
import type { GgufVariant } from "./size.ts";
import {
	COLLECTION_GUIDE as guide, collectionBreakdown, collectionSize, encodingFamily,
	selectionTotals, startingSelection, toggleVariant, variantSelected,
	type CollectionChoice, type Intent, type Publication,
} from "./collection.ts";
import "../styles/collection.css";

type Options = {
	source: string;
	returnFocus: HTMLElement;
	revision: string | null;
	inspect: (signal: AbortSignal) => Promise<Publication>;
	onBoard: (choice: CollectionChoice) => boolean;
	save: (choice: CollectionChoice) => Promise<void>;
	saveUninspected: () => Promise<void>;
};

/** A read-only inspection until the final Add. Closing aborts pending inspection. */
export function chooseCollection(options: Options): Promise<boolean> {
	return new Promise((resolve) => {
		const opener = options.returnFocus;
		const dialog = el("dialog", { class: "collection-dialog", "aria-labelledby": "collection-title" });
		const close = el("button", { type: "button", class: "collection-close", "aria-label": "Close collection picker" }, "×");
		const title = el("h2", { id: "collection-title", tabindex: "-1" }, "Choose your collection.");
		const steps = el("p", { class: "collection-steps" }, "01 · Inspect");
		const body = el("div", { class: "collection-body" });
		const footer = el("div", { class: "collection-footer" });
		const live = el("p", { class: "collection-live", role: "status", "aria-live": "polite", "aria-atomic": "true" });
		let request: AbortController | null = null;
		let publication: Publication;
		let include: string[] = [];
		let saving = false;
		let finished = false;
		let intent: Intent | null = null;
		let focused: GgufVariant | null = null;
		let announcement = 0;
		const choice = (): CollectionChoice => ({ source: publication.source, revision: publication.revision, include: [...include] });
		const finish = (saved: boolean) => {
			if (finished) return;
			finished = true;
			request?.abort();
			window.clearTimeout(announcement);
			dialog.close();
			dialog.remove();
			document.body.classList.remove("collection-open");
			if (opener?.isConnected) opener.focus();
			resolve(saved);
		};
		const announce = (message: string) => {
			window.clearTimeout(announcement);
			announcement = window.setTimeout(() => { live.textContent = message; }, 180);
		};
		close.addEventListener("click", () => { if (!saving) finish(false); });
		dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!saving) finish(false); });
		dialog.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			const stops = [...dialog.querySelectorAll<HTMLElement>("button, input, a[href], summary, [tabindex]")]
				.filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
			const first = stops[0], last = stops[stops.length - 1];
			if (!first) { event.preventDefault(); title.focus(); return; }
			const active = document.activeElement as HTMLElement;
			if (!stops.includes(active) || (event.shiftKey ? active === first : active === last)) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			}
		});
		dialog.append(
			el("header", { class: "collection-header" },
				el("div", { class: "collection-mast" }, el("span", { class: "collection-eyebrow" }, "darsay / the collection room"), steps, close),
				title, el("p", { class: "collection-source" }, options.source.replace(/^huggingface:/, ""))),
			body, footer, live,
		);
		document.body.append(dialog);
		document.body.classList.add("collection-open");
		dialog.showModal();
		title.focus();

		function sourceLink() {
			return el("a", { href: `${hfUrlFromCanonical(publication.source)}/tree/${publication.revision}`, target: "_blank", rel: "noopener noreferrer", class: "collection-source-link" }, "Read the publication ↗");
		}

		function learn(variant: GgufVariant | null): HTMLElement {
			const family = guide.families[encodingFamily(variant?.precision ?? null)];
			const companion = variant && publication.companions.includes(variant);
			const modelPack = publication.variants.length > 0;
			return el("aside", { class: "collection-learning", "aria-label": "Collection field notes" },
				el("p", { class: "collection-eyebrow" }, "A small field guide"),
				el("span", { class: "collection-specimen", "aria-hidden": "true" }, companion ? "⊕" : variant?.precision ?? (modelPack ? "GGUF" : "FILES")),
				el("h3", {}, companion ? "A companion, not a copy." : variant ? family.label : modelPack ? "One model. Many encodings." : "Preserve the publication."),
				el("p", {}, companion ? guide.companions : variant ? family.meaning : modelPack ? "A GGUF pack can publish the same model in several numerical encodings. Each complete shard group is one variant—not a piece you can leave behind." : "This source does not publish model GGUF alternatives. Its inventory still defines the collection: files, sizes, and an inspected revision."),
				el("div", { class: "collection-note" }, el("h4", {}, "Why keep this?"), el("p", {}, companion ? guide.companion_collect : variant ? family.collect : "Your collection can serve one use, preserve a comparison, or document a whole publication. The right scope follows what you care about.")),
				el("div", { class: "collection-note collection-recovery" }, el("h4", {}, guide.recovery.label), el("p", {}, modelPack ? guide.recovery.description : "Recreating exact files needs pinned inputs, tools, settings, and matching output hashes. An inventory alone does not establish reproducibility; preserve the published files you intend to collect."),
					el("details", {}, el("summary", {}, "What would count as evidence?"), el("p", {}, guide.recovery.note))),
				sourceLink(),
			);
		}

		function choose() {
			steps.textContent = "01 · Choose    /    02 · Review";
			title.textContent = "Choose your collection.";
			const main = el("section", { class: "collection-main", "aria-label": "Collection selection" });
			const notes = el("div", { class: "collection-notes" }, learn(focused));
			const intentionButtons = new Map<Intent, HTMLButtonElement>();
			const presets = el("div", { class: "collection-intents", "aria-label": "Starting points" });
			const presetNote = el("p", { class: "collection-preset-note" });
			const selectedNames = el("p", { class: "collection-selected-names" });
			const checkboxes = new Map<GgufVariant, HTMLInputElement>();
			const rowNodes = new Map<GgufVariant, HTMLElement>();
			const quantity = el("strong", { class: "collection-amount" });
			const count = el("span", { class: "collection-total-note" });
			const review = el("button", { type: "button", class: "btn collection-primary" }, "Review collection →");
			const collectionBar = el("span", { class: "collection-meter-fill" });
			const full = selectionTotals(publication.files, ["/*"]);
			const compareCaption = el("p", { class: "collection-comparison-caption" });
			const focusVariant = (v: GgufVariant) => { focused = v; notes.replaceChildren(learn(v)); };
			const update = () => {
				const total = collectionBreakdown(publication, include);
				const selected = publication.variants.filter((v) => variantSelected(v, include));
				selectedNames.textContent = include.includes("/*") ? "Selected · every published file" : include.length ? `Selected · ${[...selected, ...publication.companions.filter((v) => variantSelected(v, include))].map((v) => publication.companions.includes(v) ? v.name : v.precision ?? v.name).join(" + ")}` : "";
				quantity.textContent = `${total.unknown ? "≥ " : ""}${collectionSize(total.bytes)}`;
				quantity.title = `${total.bytes.toLocaleString()} known bytes`;
				count.textContent = `${publication.variants.length ? `${selected.length} model variant${selected.length === 1 ? "" : "s"} · ` : ""}${total.files} files${total.unknown ? ` · ${total.unknown} sizes unknown` : ""}`;
				for (const [v, checkbox] of checkboxes) {
					checkbox.checked = variantSelected(v, include);
					rowNodes.get(v)?.classList.toggle("is-selected", checkbox.checked);
				}
				for (const [key, button] of intentionButtons) button.setAttribute("aria-pressed", String(key === intent));
				presetNote.textContent = intent === "whole" ? guide.intents.whole.note : intent
					? `Starting point: the smallest complete, known-size ${intent === "compare" ? "4-bit and 8-bit variants available" : "4-bit variant available"}. ${guide.intents[intent].note}${selected.length < (intent === "compare" ? 2 : 1) ? " A requested family is unavailable; choose from the list below." : ""}`
					: include.length ? "Your selection. Add or remove complete groups below; review the new total whenever you change scope." : "Choose a starting point, or make a selection below. Nothing is selected for you.";
				const fraction = full.bytes ? Math.min(1, total.bytes / full.bytes) : 0;
				collectionBar.style.width = `${fraction * 100}%`;
				compareCaption.textContent = `${total.unknown || full.unknown ? "Known bytes only · " : ""}${collectionSize(total.bytes)} selected / ${collectionSize(full.bytes)} publication`;
				review.disabled = include.length === 0 || include.length > 256 || options.onBoard(choice());
				review.textContent = include.length && options.onBoard(choice()) ? "Already on this board" : include.length > 256 ? "Too many selectors · narrow scope" : "Review collection →";
				announce(`${quantity.textContent} selected. ${count.textContent}`);
			};
			for (const key of ["single", "compare", "whole"] as Intent[]) {
				if (!publication.variants.length && key !== "whole") continue;
				const text = guide.intents[key];
				const button = el("button", { type: "button", class: "collection-intent", "aria-pressed": "false" },
					el("span", { class: `collection-intent-mark mark-${key}`, "aria-hidden": "true" }, key === "single" ? "Ⅰ" : key === "compare" ? "Ⅱ" : "▥"),
					el("strong", {}, text.title), el("span", {}, text.description));
				button.addEventListener("click", () => {
					intent = key;
					include = startingSelection(publication.variants, key);
					const first = publication.variants.find((v) => variantSelected(v, include));
					if (first) focusVariant(first);
					update();
				});
				intentionButtons.set(key, button);
				presets.append(button);
			}
			main.append(el("p", { class: "collection-lede" }, "What would you like to keep?"), presets, selectedNames, presetNote);
			const addGroups = (groups: GgufVariant[], companion: boolean) => {
				const list = el("div", { class: "collection-variants" });
				const largest = Math.max(1, ...groups.map((v) => v.size_bytes ?? 0));
				for (const variant of groups) {
					const checkbox = el("input", { type: "checkbox", "aria-label": `Keep ${variant.name}` });
					checkbox.disabled = !variant.complete;
					const bar = el("span", { class: "collection-variant-fill" });
					bar.style.width = `${Math.max(1, (variant.size_bytes ?? 0) / largest * 100)}%`;
					const name = el("span", { class: "collection-variant-name" }, el("strong", {}, variant.precision ?? variant.name),
						el("span", { class: "collection-path" }, variant.name));
					const size = el("span", { class: "collection-variant-size", title: variant.size_bytes === null ? "Unknown size" : `${variant.size_bytes.toLocaleString()} bytes` }, collectionSize(variant.size_bytes),
						el("small", {}, `${variant.file_count} ${variant.file_count === 1 ? "file" : "shards"}${variant.complete ? " · complete" : " · incomplete"}`));
					const label = el("label", { class: "collection-variant" }, checkbox, name, size,
						el("span", { class: "collection-variant-bar", "aria-hidden": "true" }, bar));
					checkbox.addEventListener("change", () => { include = toggleVariant(publication, include, variant); intent = null; focusVariant(variant); update(); });
					checkbox.addEventListener("focus", () => focusVariant(variant));
					checkboxes.set(variant, checkbox);
					rowNodes.set(variant, label);
					list.append(label);
					const mobileNotes = el("details", { class: "collection-mobile-notes" }, el("summary", {}, `Field notes · ${variant.precision ?? "this encoding"}`));
					mobileNotes.addEventListener("toggle", () => {
						if (mobileNotes.open && mobileNotes.childElementCount === 1) mobileNotes.append(learn(variant));
					});
					list.append(mobileNotes);
					if (!variant.complete) list.append(el("p", { class: "collection-warning" }, "This group is missing or repeats declared shards. It cannot be chosen as a complete variant. The whole-publication option retains the inventory as found."));
				}
				main.append(el("div", { class: "collection-section-heading" }, el("h3", {}, companion ? "Companions, considered separately" : "The published variants"), el("span", {}, `${groups.length} ${companion ? "companions" : "alternatives"}`)));
				if (companion) main.append(el("p", { class: "collection-explainer" }, guide.companions));
				main.append(list);
			};
			if (publication.variants.length) addGroups(publication.variants, false);
			else main.append(el("p", { class: "collection-explainer" }, "No model GGUF variants were found. You can collect the whole publication here, or use explicit include patterns in the add form for a narrower scope."));
			if (publication.companions.length) addGroups(publication.companions, true);
			main.append(el("div", { class: "collection-support-note" }, el("strong", {}, "The context comes with it."), el("p", {}, "Recognized support files—model cards, licenses, tokenizers, configurations, and code—accompany your selection, counted once. Other files are included only by your selectors or the whole-publication choice.")));
			body.replaceChildren(el("div", { class: "collection-layout" }, main, notes));
			footer.replaceChildren(el("div", { class: "collection-comparison" }, compareCaption, el("div", { class: "collection-meter", "aria-hidden": "true" }, collectionBar)),
				el("div", { class: "collection-footer-row" }, el("div", { class: "collection-total" }, el("span", { class: "collection-eyebrow" }, "Your collection · disk bytes"), quantity, count), review),
				el("p", { class: "collection-footer-fine" }, "A scope decision, not a claim that the rest is disposable. No model bytes are downloaded by the board."));
			review.addEventListener("click", reviewCollection);
			update();
		}

		function reviewCollection() {
			steps.textContent = "01 · Choose    /    02 · Review";
			title.textContent = "A collection with intention.";
			const total = collectionBreakdown(publication, include);
			const whole = include.includes("/*");
			const models = publication.variants.filter((v) => variantSelected(v, include));
			const companions = publication.companions.filter((v) => variantSelected(v, include));
			const list = el("ul", { class: "collection-review-list" });
			for (const v of [...models, ...companions]) list.append(el("li", {}, el("span", {}, v.name + (v.complete ? "" : " · incomplete group, retained as found")), el("strong", {}, collectionSize(v.size_bytes))));
			const selectors = el("details", { class: "collection-selectors" }, el("summary", {}, "Exact include selectors"), el("pre", {}, el("code", {}, include.join("\n"))));
			body.replaceChildren(el("section", { class: "collection-review", "aria-label": "Review collection" },
				el("p", { class: "collection-eyebrow" }, whole ? "Whole publication / one board row" : "Selected variants / one board row"),
				el("p", { class: "collection-review-amount" }, `${total.unknown ? "≥ " : ""}${collectionSize(total.bytes)}`),
				el("p", { class: "collection-review-bytes" }, `${total.bytes.toLocaleString()} known bytes`),
				el("p", { class: "collection-lede" }, `${publication.variants.length ? `${models.length} model variant${models.length === 1 ? "" : "s"}, ${companions.length} companion${companions.length === 1 ? "" : "s"}. ` : ""}${total.files} files in all.`),
				list, el("p", { class: "collection-explainer" }, publication.variants.length ? `${total.supporting} support or other selected files, counted once. ${guide.sizing}` : "Every file in the inspected publication, counted once. Disk size is not a RAM or VRAM requirement."),
				...(total.unknown ? [el("p", { class: "collection-warning" }, `${total.unknown} file sizes are unknown. This total is a lower bound, not a storage budget.`)] : []),
				...(!companions.length && publication.companions.length ? [el("p", { class: "collection-warning" }, "No projector selected. Multimodal use may need a matching companion; consult the publisher and runtime.")] : []),
				...(models.length > 1 ? [el("p", { class: "collection-explainer" }, "These alternatives form one archive collection, not one runnable model. Choose an encoding and compatible companions separately when preparing a runtime.")] : []),
				el("div", { class: "collection-pin" }, el("span", { class: "collection-eyebrow" }, "Pinned to the inspected revision"), el("code", {}, publication.revision), el("p", {}, "The saved row uses this exact commit. A moving branch cannot silently change this selection.")),
				selectors, el("p", { class: "collection-explainer" }, guide.scope),
			));
			saveFooter(() => options.save(choice()), () => choose(), "Add this collection", "← Refine selection");
		}

		function saveFooter(save: () => Promise<void>, goBack: () => void, label: string, backLabel: string) {
			const back = el("button", { type: "button", class: "btn" }, backLabel);
			const add = el("button", { type: "button", class: "btn collection-primary" }, label);
			const error = el("p", { class: "collection-error", role: "alert" });
			back.addEventListener("click", () => { goBack(); title.focus(); });
			add.addEventListener("click", async () => {
				if (saving) return;
				saving = true;
				add.disabled = back.disabled = close.disabled = true;
				add.textContent = "Adding collection…";
				error.textContent = "";
				try { await save(); finish(true); }
				catch (err) {
					error.textContent = `${err instanceof Error ? err.message : "Could not add the collection."} Your selection is still here; retry when ready.`;
					saving = false;
					add.disabled = back.disabled = close.disabled = false;
					add.textContent = "Retry save";
				}
			});
			footer.replaceChildren(error, el("div", { class: "collection-review-actions" }, back, add), el("p", { class: "collection-footer-fine" }, "This saves a want-list row. Archiving happens later, in your vault."));
			title.focus();
			body.scrollTop = 0;
		}

		function reviewUninspected() {
			title.textContent = "A place on the want-list.";
			steps.textContent = "Uninspected / confirm scope";
			body.replaceChildren(el("section", { class: "collection-review", "aria-label": "Review uninspected publication" },
				el("p", { class: "collection-eyebrow" }, "Whole publication / not inspected"),
				el("p", { class: "collection-review-amount" }, "Size unknown"),
				el("p", { class: "collection-lede" }, "Keep the intention. Don’t guess the inventory."),
				el("p", { class: "collection-explainer" }, "This row will request every published path with /*. No variant choice, file completeness, storage budget, or recreation evidence has been reviewed here. The publication may be much larger than one model copy."),
				el("div", { class: "collection-pin" }, el("span", { class: "collection-eyebrow" }, "Requested revision · not resolved here"), el("code", {}, options.revision ?? "main"), el("p", {}, "The CLI resolves and pins it when archiving begins. A branch can move before then.")),
				el("p", { class: "collection-warning" }, "Archive only after checking your access, intended scope, and available disk. This saves a want-list row; it does not download model bytes."),
			));
			saveFooter(options.saveUninspected, () => void inspect(), "Add uninspected publication", "← Try inspection");
		}

		async function inspect() {
			title.textContent = "Choose your collection.";
			steps.textContent = "01 · Inspect";
			request?.abort();
			const current = new AbortController();
			request = current;
			body.replaceChildren(el("div", { class: "collection-inspecting", role: "status" },
				el("div", { class: "collection-inventory-art", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("i"), el("i")),
				el("h3", {}, "Opening the publication…"), el("p", {}, "Reading file sizes, gathering every shard, and separating model variants from their companions."),
				el("p", { class: "collection-explainer" }, "Metadata only. No model bytes downloaded. No board row created.")));
			footer.replaceChildren(el("p", { class: "collection-footer-fine" }, "The publication—not the filename alone—sets the scope."));
			try {
				const result = await options.inspect(current.signal);
				if (finished || current.signal.aborted) return;
				publication = result;
				choose();
				announce(`${publication.variants.length} model variants found. Choose your collection.`);
			} catch (err) {
				if (finished || current.signal.aborted) return;
				const retry = el("button", { type: "button", class: "btn collection-primary" }, "Try inspection again");
				retry.addEventListener("click", () => void inspect());
				const uninspected = el("button", { type: "button", class: "btn collection-uninspected" }, "Keep an uninspected publication…");
				uninspected.addEventListener("click", reviewUninspected);
				body.replaceChildren(el("div", { class: "collection-inspecting" }, el("h3", {}, "We couldn’t inspect this publication."),
					el("p", { class: "collection-error", role: "alert" }, err instanceof Error ? err.message : "The Hub could not be reached."),
					el("p", {}, "Check the source, revision, and whether it is public. Your form is unchanged. Close this window to edit it, or explicitly keep an uninspected whole-publication request."), retry, uninspected));
			}
		}
		void inspect();
	});
}

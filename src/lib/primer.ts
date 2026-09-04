/**
 * The field guide: static teaching cards a board opens from its chips,
 * lenses, and facts. Authored copy only — rendered through `inline()`
 * (backticks → <code>), never from user text. Wording follows the docs;
 * every `doc` anchor is checked against `src/content/docs` in the tests.
 * Sizes are GiB, like the board and the CLI's own output.
 */
import type { LensKey } from "./lenses.ts";

export type PrimerKey =
	| "archive"
	| "quant"
	| "formats"
	| "dtype"
	| "bundle"
	| "pin"
	| "mv"
	| "large"
	| "gated"
	| "redundant"
	| "subset"
	| "abliterated"
	| "base"
	| "moe"
	| "spec"
	| "dataset"
	| "family"
	| "closed"
	| "desire"
	| "claims"
	| "agents";

export type PrimerGroup = "Policy" | "Formats" | "Anatomy" | "Names" | "Lineage" | "The ledger";

export type PrimerCard = {
	key: PrimerKey;
	group: PrimerGroup;
	/** Serif italic headline. */
	title: string;
	/** The idea in one sentence. */
	lede: string;
	/** Short paragraphs; `backticks` render as code. */
	body: string[];
	table?: { head: string[]; rows: string[][] };
	/** The collector's verdict: what to keep, and why. */
	collect: string;
	/** A terminal stage under the card. */
	cmd?: { label: string; lines: string[] };
	doc?: { href: string; label: string };
	/** An outside reference (a paper), opened in a new tab. */
	link?: { href: string; label: string };
	related: PrimerKey[];
	/** The board lens this card explains, for "show on the board". */
	lens?: LensKey;
};

export const PRIMER: PrimerCard[] = [
	{
		key: "archive",
		group: "Policy",
		title: "Scope, lineage, and recovery",
		lede: "Choose the collection scope first, identify the artifact and its lineage, then examine recovery evidence before deciding what to retain or omit.",
		body: [
			"A `repository total` counts every published file at a revision. A `selection` counts the row's include patterns plus support files. An `archive` counts the files retained by classification, including retained prints and unresolved weights. These are different collection scopes. Selecting one quant narrows the collection; it does not establish that the other artifacts can be recreated.",
			"**Negative** means a conservative preservation candidate, not a proven original artifact. **Print** describes an established derivative relationship, not permission to omit the artifact. Neither label is sufficient recovery evidence. A derived artifact can have historical value, and a declared parent identifies lineage without supplying a recipe for exact byte recovery. A `BF16` label describes an encoding; it does not establish original training provenance or make it preferable to the publisher's FP8 release.",
			"Automatic omission is limited to **R15**: a byte-identical duplicate whose retained source is in the same bundle. **R2**, a match to an upstream file, is retained because an upstream reference is not a local recovery guarantee. **R9**, a GGUF beside another weight format, remains unknown and is retained. The manifest records every omitted path, its evidence, and the retained recovery source. Recoverable bytes do not mean the omitted paths already exist; use `--full` when you need the complete published layout.",
			"`Refresh size` updates the Hub inventory and selected-file sizes. `darsay estimate <board-url>` records archive classification. A `≥` amount is a lower bound because some sizes are unknown. Toolbar totals keep the scopes separate; overlapping rows can still request the same files. `--full` explicitly keeps the complete published repository.",
		],
		collect:
			"Decide which publication or selected artifact matters to your collection. Preserve it unless the recorded recovery evidence justifies omission; a format label or parent relationship is not enough.",
		cmd: {
			label: "the evidence table",
			lines: [
				"darsay classify owner/model",
				"darsay archive  owner/model          # retain unless same-bundle duplication is proven",
				"darsay archive  owner/model --full   # every published byte instead",
			],
		},
		doc: {
			href: "/docs/quantization/#4-mechanics",
			label: "Quantization → mechanics",
		},
		related: ["quant", "dtype", "redundant", "formats"],
		lens: "archive",
	},
	{
		key: "quant",
		group: "Formats",
		title: "Quants",
		lede: "Quantization changes how weights are represented. The published encoding, its source lineage, and its recoverability are separate facts.",
		body: [
			"`BF16` and `F16` use two bytes per stored parameter; `FP8` uses roughly one, and a four-bit encoding starts near half a byte before scales and metadata. `Q4_K_M`, `IQ2_XS`, `AWQ`, and `GPTQ` describe encoding families. A larger encoding can result from converting a smaller one; its bit width alone cannot recover information that was already rounded away.",
			"Recreating a published quant can depend on the exact source revision, conversion software, options, calibration inputs, and numerical behavior. An imatrix marker establishes that an importance matrix was used; it does not establish that the corpus was private or that recovery is impossible. Absence of that marker does not prove that recovery is possible. Inspect the available evidence rather than assigning either conclusion from the label.",
			"The `quant` chip comes from GGUF inventory or a dominant dtype below the usual 16-bit formats. GGUF can also store BF16 values, so read the specific variant's precision. A publisher's FP8 release and another publisher's BF16 conversion are distinct publications. Compare their lineage and your collection purpose before selecting either.",
		],
		collect:
			"Collect the published artifact you need, whether for historical reproduction or local use. Choosing a smaller variant is an explicit scope choice; it is not proof that the other variants are disposable.",
		cmd: {
			label: "price the ecosystem",
			lines: [
				"darsay estimate owner/model --variants   # the quantized ecosystem, sized",
				"darsay archive  owner/model-FP8          # a published quant is an ordinary bundle",
			],
		},
		doc: { href: "/docs/quantization/#1-negatives-and-prints", label: "Quantization → negatives and prints" },
		related: ["archive", "formats", "dtype", "subset"],
		lens: "quant",
	},
	{
		key: "formats",
		group: "Formats",
		title: "GGUF, safetensors, and the rest",
		lede: "The file extension describes a container and its loader. It does not establish the artifact's origin or whether its bytes can be recovered.",
		body: [
			"**safetensors** is the Hub's native format: a JSON header naming every tensor with its shape and dtype, then raw bytes. Big models shard into `model-00001-of-00028.safetensors` with a `model.safetensors.index.json` that says which shards make the loadable set. darsay reads that index, and a header only for a file no index accounts for — a few dozen kilobytes each — to classify a repo without downloading it.",
			"**GGUF** carries tensor data and metadata such as architecture, quantization type, and sometimes `quantize.imatrix.*` entries. A large GGUF can span many shards; those files form one variant, and later shards may carry only split metadata. A repository can contain many variants plus separate projectors. Keep all shards of the chosen variant and check whether its use also needs a projector.",
			"A complete publication and one runnable variant are both useful collection scopes. The board lists actual GGUF groups and verified selectors so you can choose deliberately. Finding GGUF beside safetensors does not prove that the GGUF can be recreated from those tensors: **R9** retains it as unknown. PyTorch `.bin`, `.pt`, and `.pth` files are also retained when no recovery evidence is established.",
		],
		table: {
			head: ["File", "Made for", "What the header tells darsay"],
			rows: [
				["*.safetensors", "transformers, vLLM, MLX", "tensor names, shapes, dtype"],
				["*.gguf", "llama.cpp", "quant level, imatrix, source claims"],
				["*.bin · *.pt", "legacy PyTorch", "retained unless same-bundle hashes prove a duplicate"],
			],
		},
		collect:
			"Choose a whole publication or the specific format and variant you intend to preserve. Include every shard and any required companions; judge recovery from evidence, not the extension.",
		cmd: {
			label: "one quant of a pack",
			lines: [
				"darsay estimate unsloth/Model-GGUF --include '*Q4_K_M*'",
				"darsay archive  unsloth/Model-GGUF --include '*Q4_K_M*'",
			],
		},
		doc: { href: "/docs/hydration/#engines", label: "Hydration → engines" },
		related: ["quant", "subset", "dtype", "bundle"],
	},
	{
		key: "dtype",
		group: "Formats",
		title: "Precision and bytes per parameter",
		lede: "Parameter count describes the model. Precision describes a weight encoding. Repository size can add many encodings together, so it is not the size of one model copy.",
		body: [
			"A row shows the parameter count and precision when available, independently. Parameters may come from safetensors metadata or the Hub's GGUF metadata. `BF16` and `F16` use two bytes per parameter; `F32` four; `FP8` and `INT8` one. Quantized formats pack weights with additional scales and metadata. In a GGUF pack, each variant has its own precision and byte count; the board does not present the combined repository bytes per parameter as a model precision.",
			"For example, one trillion BF16 parameters occupy roughly 1.8 TiB in weight values. A four-bit encoding of the same parameter count starts near 466 GiB before scales and metadata. Publishing both encodings adds their storage together without adding parameters to the model. Converting FP8 values into BF16 storage does not establish that the result is an original BF16 checkpoint.",
			"Far above two bytes a parameter is the other story: a 27.78B BF16 model should weigh 51.7 GiB, and when the repo weighs 223 GiB it ships several weight sets. `estimate` flags that ratio at 1.75× as `redundant`, and `classify` lays the sets out.",
		],
		table: {
			head: ["release precision", "bytes / param", "27.78B weighs", "2.45T weighs"],
			rows: [
				["F32", "4", "103 GiB", "8.9 TiB"],
				["BF16 · F16", "2", "51.7 GiB", "4.4 TiB"],
				["FP8 · INT8", "1", "25.9 GiB", "2.2 TiB"],
				["MXFP4 · NVFP4 · INT4", "≈ 0.5–0.6", "13–16 GiB", "1.2–1.4 TiB"],
			],
		},
		collect:
			"Read the size scope first, then parameters and precision. For a repository with several variants, compare each variant's bytes. A format label describes storage, not whether the classifier proved a negative or print.",
		doc: { href: "/docs/catalogs/#estimate-digest", label: "Catalogs → the estimate digest" },
		related: ["archive", "redundant", "quant", "formats"],
	},
	{
		key: "bundle",
		group: "Anatomy",
		title: "Anatomy of a bundle",
		lede: "One pinned revision of one source, stored as a museum record that is also a working checkout.",
		body: [
			"`model/` (or `data/` for a dataset) is the selected payload, frozen after archive. Retained files preserve their upstream bytes. A subset or omitted duplicate path can change the published layout, so check the loader's required files and paths; `--full` preserves the complete repository layout.",
			"Beside it the tool writes what it established — `manifest.json` (facts, `null` where nothing was established, every query cap recorded), generated views like `README.md` and `VERIFICATION.md`, and `LICENSE` surfaced at the root. `curation.md` is the one file you write by hand; darsay never overwrites it.",
			"Anything needed to *run* the model — torch, llama-cpp, a Python environment — is hydration. It lives under `<vault>/.runtime/`, content-keyed and shared, and can be deleted at will. The bundle hash covers the payload only.",
		],
		collect:
			"Preserve the payload, manifest, and handwritten curation together. Generated views can be rebuilt; your curation cannot be recovered from model bytes alone.",
		cmd: {
			label: "the tree",
			lines: [
				"~/darsay/qwen--qwen3.8-27b/<rev>/",
				"├── model/           # the payload, frozen",
				"├── manifest.json    # facts, never guesses",
				"├── README.md        # generated view",
				"├── curation.md      # yours",
				"└── LICENSE",
			],
		},
		doc: { href: "/docs/concepts/#bundle", label: "Concepts → bundle" },
		related: ["pin", "dataset", "archive"],
	},
	{
		key: "pin",
		group: "Anatomy",
		title: "The pin",
		lede: "archive does not mean “download main”. It means resolve, freeze, then transfer until every file verifies.",
		body: [
			"First the ref — `main`, a tag, a commit — resolves to an immutable revision. Then the file set is frozen: by default the classified archive including unresolved weights, with `--full` the whole repo, with `--include` the selected files plus support files. Only then do bytes move.",
			"Rerunning `archive` on the same source continues that pin — same files, same selection. That is why resume needs no special subcommand, and why a 700 GiB job can be seventy evenings of `--max-gb 10`. It never chases a moving `main`; to take a new snapshot, `--force` pins again.",
			"A row on this board may carry a revision; unpinned rows resolve at the collector's first run. A **skeleton** is a pin whose verified bytes were handed to another disk with `assemble --handoff`: the hashes stay, the payload travels, and nothing is fetched twice.",
		],
		collect:
			"Pin when it matters which bytes — a paper's exact checkpoint, a release you are matching with a friend. Otherwise let the first archive freeze it.",
		cmd: {
			label: "resume is the same line",
			lines: [
				"darsay archive owner/model --max-gb 10   # tonight",
				"darsay archive owner/model --max-gb 10   # tomorrow: the same pin",
				"darsay archive owner/model --force       # a new snapshot",
			],
		},
		doc: { href: "/docs/concepts/#pin", label: "Concepts → pin" },
		related: ["bundle", "large", "subset", "mv"],
	},
	{
		key: "mv",
		group: "Anatomy",
		title: "Move and hand-off",
		lede: "Two verbs carry a pin across a disk boundary, and they are not interchangeable: one moves a bundle you finished, the other hands over one you did not.",
		body: [
			"`darsay mv <bundle> <vault>` takes a **registered** bundle — one that has a `manifest.json` — and a destination vault root that already exists. On one filesystem it is a rename: instant, nothing rewritten. Across filesystems it copies into a staging directory beside the destination, re-hashes every payload file *there* against the manifest, stamps the new location, renames the copy into place, and only then removes the source. A failed verification deletes the staging copy and leaves the source exactly as it was. `-n` says which of the two it will do, and where the bundle lands, before it does either.",
			"`assemble --handoff` acts on the other object: a **partial**, still a `transfer.json` with no manifest, crossing one verified payload file at a time and leaving a skeleton — the pin, the expected inventory, every hash, no bytes. Each verb refuses the other's object and names the right one. That refusal is why the flag stopped being spelled `--move` the day `darsay mv` arrived: two things called *move*, acting on different objects, is a trap for the reader and for the shell history.",
			"Neither changes the bundle hash — it covers the payload, and the payload is never touched. The manifest does change (location, host, and a `moves` record naming `rename` or `copy`), so an export taken after a move is not byte-identical to one taken before. `darsay cp` is `mv` without the removal: the same copy, the same verification at the destination, and afterwards both manifests carry the other as a replica.",
		],
		table: {
			head: ["Verb", "Acts on", "Leaves behind"],
			rows: [
				["darsay mv", "a registered bundle, whole", "nothing — the empty folder is swept"],
				["assemble --handoff", "a partial, one file at a time", "a skeleton, until the last file crosses"],
			],
		},
		collect:
			"A finished bundle changing disks is `mv`. One pin crossing two disks that never mount together is `--handoff`. If the destination is a file rather than a vault — a shelf, a stranger — it is `export` instead.",
		cmd: {
			label: "move it, or keep a second copy",
			lines: [
				"darsay mv qwen--qwen3-0.6b /Volumes/big -n   # rename or copy? where it lands",
				"darsay mv qwen--qwen3-0.6b /Volumes/big",
				"darsay cp qwen--qwen3-0.6b /Volumes/backup   # same verification, source kept",
			],
		},
		doc: { href: "/docs/faq/#moving-bundles", label: "FAQ → moving bundles" },
		related: ["bundle", "pin", "large"],
	},
	{
		key: "large",
		group: "Policy",
		title: "Large",
		lede: "Twenty gibibytes is where a download stops being one sitting and starts being a plan.",
		body: [
			"The `large` chip is the CLI's line — a priced payload of 20 GiB or more, the same constant this board draws. Above it, think in sessions: `--max-gb` caps tonight, `--min-free` keeps a floor on the disk, `--max-minutes` ends before the café closes. Completed files are trusted; partial files resume with a Range request.",
			"Above a few hundred gibibytes, think in disks and people. `assemble --handoff` hands a fetched half to the drive that has room and leaves a skeleton behind, so the laptop never re-fetches what it gave away. `--shard 1/2` lets two collectors prefer different halves and merge offline.",
			"The scope beside every row size says whether it covers the repository, a selection, or the classified archive. A GGUF pack lists its variants and their separate sizes. Choose the desired scope before budgeting a transfer; unknown file sizes make the displayed amount a lower bound.",
		],
		collect: "Large is not a reason to skip — it is a reason to budget. The recipe card under each row writes the flags for you.",
		doc: { href: "/docs/examples/#pause-and-resume-a-large-archive", label: "Cookbook → pause and resume" },
		related: ["pin", "archive", "dtype", "claims"],
		lens: "large",
	},
	{
		key: "gated",
		group: "Policy",
		title: "Gated",
		lede: "Some authors ask you to accept their terms before the files are served. darsay does not go around that.",
		body: [
			"A gated repo refuses anonymous requests. Accept the terms once on the model page, run `hf auth login` once on the machine, and every darsay verb works as before — the gate is enforced server-side; darsay carries your token, it does not forge one.",
			"Gating can hide a file's header or inventory until you are signed in. Missing evidence stays unknown; it is not filled in from a name or format. The classifier retains unresolved files unless verified byte duplication establishes recovery from another retained file in the same bundle.",
		],
		collect: "Accept the terms while the author is still there to grant them. A gate that closes later is one more way a repo vanishes.",
		cmd: {
			label: "once per machine",
			lines: ["hf auth login                 # after accepting the terms on huggingface.co", "darsay archive owner/model"],
		},
		doc: { href: "/docs/catalogs/#hints", label: "Catalogs → hints" },
		related: ["archive", "pin"],
		lens: "gated",
	},
	{
		key: "redundant",
		group: "Policy",
		title: "Redundant",
		lede: "The weight inventory exceeds a simple one-copy estimate. Inspect what contributes those bytes before deciding whether the collection should be smaller.",
		body: [
			"The smell is arithmetic. `estimate` multiplies the published per-dtype parameter counts by their widths to get one copy's weight bytes; when the repo's weight files total 1.75× that or more, the row gets `redundant`. An exact second copy is 2.0×.",
			"Extra bytes can represent alternative encodings, distinct trained components, historical builds, or byte-identical copies. Only the last category, with a retained source in the same bundle, supports automatic omission under **R15**. A matching upstream file is retained under **R2**; a GGUF beside safetensors is retained as unknown under **R9**.",
			"`darsay classify` lists sets, lineage evidence, verdicts, and omission decisions separately. A high byte ratio is a reason to inspect the inventory. It does not establish that the publisher's files are unnecessary, and it does not decide whether your collection should cover the whole repository or one variant.",
		],
		collect:
			"Use the ratio to find repositories worth examining. Decide the scope explicitly, and permit omission only when exact recovery from retained bytes is established.",
		cmd: {
			label: "what is in the box",
			lines: [
				"darsay classify owner/model",
				"darsay estimate owner/model            # retained archive after classification",
				"darsay estimate owner/model --full     # the shipping box",
			],
		},
		doc: {
			href: "/docs/quantization/#4-mechanics",
			label: "Quantization → mechanics",
		},
		related: ["dtype", "archive", "quant"],
		lens: "redundant",
	},
	{
		key: "subset",
		group: "Policy",
		title: "Choose a collection",
		lede: "A publication can contain many encodings. Choose the scope that matters to you, then review its actual files and disk bytes.",
		body: [
			"Enter a Hub source and choose **Explore collection**. Nothing is selected until you act. **One considered copy** starts with the smallest complete, known-size 4-bit variant; **A comparison pair** chooses that and an 8-bit counterpart; **The whole publication** selects every file. These are editable storage-oriented starting points, not publisher recommendations, quality rankings, or hardware-fit claims. A missing family has no guessed substitute.",
			"A repository may publish many GGUF alternatives. You can collect that complete publication or choose one for a particular use. `--include` is a repeatable glob; a leading `/` anchors it to the repo root. The board supplies selectors checked against the inventory and groups all shards of a variant. Recognized support files accompany the match; optional projectors require a separate explicit selection.",
			"**Review collection** names the exact commit, combined selectors, companions, and file total before **Add this collection** saves one row. Shared support files count once. Whole-publication scope uses `/*`; toggling a group afterwards changes it to selected-group scope. Closing the dialog creates no row and downloads no model payload. Field notes explain encodings and recovery evidence; on a phone they open beneath each variant.",
			"If inspection fails, retry or explicitly keep an **uninspected publication**. That separate review says **Size unknown** and requests every path with `/*` at the supplied revision, resolved when archiving starts. No fallback or variant choice is automatic. One source/revision has one collection per vault; combine variants you intend to keep together. A conflicting explicit scope is refused rather than silently changed.",
			"**Exact recovery unverified** means the inventory cannot establish how hard these bytes are to recreate. That needs pinned source weights, tools, settings, calibration inputs where used, and matching output hashes. No recreation cost is invented. A collection with several encodings is not one runnable model; choose the runtime's encoding and compatible companions separately.",
			"A fresh interactive `darsay archive` opens the terminal collection room for multi-variant GGUF models. `1/2/3` chooses a starting point, Space toggles a group, `?` opens field notes, and Enter reviews before confirming. Explicit includes, `--full`, board/catalog jobs, and non-interactive runs bypass it. `--yes` uses the default archive policy, not a default quant. A direct-source rerun resumes the pin's scope; a board job must still match its row's identity.",
		],
		collect:
			"Collect deliberately. Combine variants in one new collection, or use an existing row's Add variant action for a separate row. Unselected files are outside the scope, not proven recoverable or disposable.",
		cmd: {
			label: "one glob",
			lines: [
				"darsay estimate owner/Model-GGUF --include '*Q4_K_M*'",
				"darsay archive  owner/Model-GGUF --include '*Q4_K_M*'",
			],
		},
		doc: {
			href: "/docs/quantization/#implemented-subset-archiving-archive---include",
			label: "Quantization → subset archiving",
		},
		related: ["formats", "quant", "pin"],
		lens: "subset",
	},
	{
		key: "abliterated",
		group: "Names",
		title: "Abliterated",
		lede: "A name such as abliterated or heretic claims an edit to model behavior. The name alone does not establish the exact method, its effects, or its recoverability.",
		body: [
			"Refusal-direction ablation is one documented method of editing behavior, and community publications use several related names. The board reads those names as a discovery hint. Establish the actual operation from the publication and its metadata; do not assume every similarly named model used the same method or preserved every other behavior.",
			"Recovering an edited publication may require the exact base revision, prompts or direction vectors, code, options, and numerical environment. Some authors publish those inputs and others do not. Neither universal irreversibility nor an unavailable recipe follows from the word *abliterated*. A declared relationship to a base is lineage evidence, not an omission instruction.",
			"Keep the edited artifact if it belongs in your collection. Compare its declared base as a separate publication, and record whatever recovery evidence exists. The classifier retains unresolved weight sets; a storage format or an evocative name cannot substitute for that evidence.",
		],
		collect:
			"Choose whether your collection covers the base, the edited publication, or both. Preserve exact published bytes until the available recovery evidence supports a different decision.",
		link: {
			href: "https://arxiv.org/abs/2406.11717",
			label: "Arditi et al., 2024 — Refusal in language models is mediated by a single direction",
		},
		doc: { href: "/docs/quantization/#3-policy", label: "Quantization → policy" },
		related: ["archive", "family", "redundant", "base"],
		lens: "abliterated",
	},
	{
		key: "base",
		group: "Names",
		title: "Base vs. post-trained",
		lede: "A base model has only been pretrained. Everything you would actually talk to was trained further on top of one.",
		body: [
			"Pretraining reads trillions of tokens and produces a model that completes text — the base, usually suffixed `-Base` or `-pt`. Post-training (instruction tuning, RLHF, distillation) turns it into the `-Instruct`, `-Chat` or unsuffixed release that answers questions. The base is published separately, when it is published at all.",
			"The base is a lineage starting point for further training; an instruct release is one branch. They are separate published artifacts. Reproducing the instruct release requires more than possession of the base: the exact training inputs and process must also be established.",
		],
		collect:
			"For a model family you care about, keep one base and the post-trained release you use. The base is the seed; the instruct is the harvest.",
		related: ["abliterated", "family", "moe", "archive"],
		lens: "base",
	},
	{
		key: "moe",
		group: "Names",
		title: "Mixture of experts",
		lede: "480B-A35B: four hundred and eighty billion parameters on disk, thirty-five billion at work for any one token.",
		body: [
			"A mixture-of-experts model splits its feed-forward layers into many experts and routes each token through a few. The name records both numbers: total parameters — what you archive — and active parameters — what each token touches, roughly the compute and speed of a dense model that size.",
			"For the collector the first number is the one that matters. The vault holds every expert, because the router may call any of them; RAM to run it is nearer the total too — darsay's preflight compares free memory to weights × 1.2. The second number is why a 480B model can feel like a 35B one once it is loaded.",
			"MoE models that do not say so in the name — `-A35B`, `8x7B`, `MoE` — are not counted.",
		],
		collect: "Budget disk by the total, and do not mistake “only 35B active” for a small download.",
		doc: { href: "/docs/hydration/#engines", label: "Hydration → preflight" },
		related: ["large", "dtype", "base"],
		lens: "moe",
	},
	{
		key: "spec",
		group: "Names",
		title: "Speculative decoders",
		lede: "A small model guesses the next several tokens; the big model checks them all in one pass. The same answer, often two or three times sooner.",
		body: [
			"Decoding is one token per forward pass, and a 400B model's pass is mostly waiting on memory. Speculative decoding puts a cheap **draft** in front of the **target**: the draft proposes a run of tokens, the target verifies the run in a single pass and keeps the longest correct prefix. With the standard accept-or-resample rule the output distribution is exactly the target's — only the clock changes.",
			"The draft comes in three shapes on the Hub. A separate small model of the same family and tokenizer (`Qwen3-0.6B` drafting for `Qwen3-32B`). A trained head bolted onto a particular target — **EAGLE**, **Medusa**, **HASS** — published in a separate repo. Or **MTP** layers — multi-token prediction — included in a main weight set. MTP weights are archived with that set when it belongs to the selected scope; a separate draft publication has its own row.",
			"Vocabulary is the contract: draft and target must share a tokenizer, and a head was trained on one target's hidden states. Pair them in the same catalog at the same desire. A draft alone is a curiosity; a head alone is a paperweight.",
		],
		collect:
			"Collect a draft or head with the target and runtime it was designed for. Preserve their exact revisions and declared relationship; a lineage label alone does not prove compatibility or recoverability.",
		link: {
			href: "https://arxiv.org/abs/2211.17192",
			label: "Leviathan et al., 2023 — Fast inference from transformers via speculative decoding",
		},
		related: ["moe", "base", "dtype"],
		lens: "spec",
	},
	{
		key: "dataset",
		group: "Anatomy",
		title: "Datasets",
		lede: "The second artifact type. Addressed as datasets/owner/name, payload under data/, same verbs.",
		body: [
			"A dataset bundle has the same four parts as a model bundle: a frozen `data/` payload, a manifest of recorded facts, generated views, and your `curation.md`. It has no engine — `hydrate` and `run` do not apply; open the parquet, jsonl or csv with whatever already reads the format.",
			"A vault holding a model but not what it was trained on preserves the sculpture and discards the quarry. Datasets are the more endangered half — taken down, gated after the fact, quietly rewritten, rarely mirrored. The manifest records what upstream declared, including the license, and measures only what it can.",
		],
		collect: "For every lineage you keep, consider keeping what it was trained on — or at least what you would fine-tune it with.",
		cmd: {
			label: "same verbs",
			lines: [
				"darsay estimate datasets/owner/name",
				"darsay archive  datasets/owner/name",
				"darsay info     datasets--owner--name",
			],
		},
		doc: { href: "/docs/datasets/", label: "Datasets" },
		related: ["bundle", "base"],
		lens: "dataset",
	},
	{
		key: "family",
		group: "Lineage",
		title: "Families, generations, members",
		lede: "Works come in families, families in generations, generations have members — and darsay reads all three from the name the publisher gave the work.",
		body: [
			"`Qwen3.8-2.4T-A95B` says family **Qwen**, generation **3.8**, member **2.4T-A95B**. `Kimi-K2-Base` says Kimi, K2, the flagship, variant *base*. `GLM-5.3-Flash-Uncensored-GGUF` says GLM, 5.3, member Flash, variant *uncensored*, format *gguf*. The grammar is documented, runs identically on this board and in the CLI, and is labeled *read from the name* wherever it shows — a name is evidence, never a verdict about the bytes.",
			"Generations order numerically within a family, so a family's timeline is mechanical: Qwen 3 → 3.5 → 3.8; Kimi K2 → K2.5 → K3. A member with a different publisher than its family — an abliteration, a community GGUF pack — is a derivative, and when upstream declared its parent (a `finetune`, `quantized`, or `trained_on` edge on the model card), the board nests it under that parent.",
			"The **Lineage** view draws the tree: every family on this board, its generations oldest first, the members of each with their size, precision, and status. A closed work sits in the same tree beside its open siblings. The `Qwen 3.8` chip on a row is the same fact, one click from the whole family.",
		],
		collect:
			"Collect a lineage, not a list: one base, the post-trained release you use, and the next generation when it lands. The tree tells you what you are missing.",
		cmd: {
			label: "the tree, on the command line",
			lines: ["darsay list summer --sort family    # family · generation · size, with FAMILY and PRECISION columns"],
		},
		doc: { href: "/docs/concepts/", label: "Concepts → lineage" },
		related: ["closed", "base", "abliterated", "dtype"],
	},
	{
		key: "closed",
		group: "Lineage",
		title: "Closed weights",
		lede: "An API-only model, an announced release: a work that exists but cannot be fetched still belongs in the tree.",
		body: [
			"Paste the work's home page — `https://www.qwencloud.com/models/qwen3.8-max-0902` — and the row is **closed**: no price, nothing to fetch, `--next` never picks it. The name at the end of the address is read by the same grammar as a repo name, so `qwen3.8-max-0902` lands in Qwen generation 3.8 beside `2.4T-A95B` and `27B`, and the Lineage view shows the flagship the open members stand next to.",
			"A closed row carries no pin and no include globs — there is nothing to pin. It carries desire and a note, like any row, and it exports in the catalog as its address. When the weights are published, add the source ref as a new row and drop the home; the family is unchanged, the place is filled.",
			"The CLI's `catalog add` accepts the same address and shows the row as `closed` in `list`.",
		],
		collect:
			"Hold the place. A family with its flagship missing is a story with a hole in it; a closed row says the hole is known, and what would fill it.",
		cmd: {
			label: "when the weights ship",
			lines: ["darsay catalog add  summer Qwen/Qwen3.8-Max --desire 7", "darsay catalog drop summer 'https://www.qwencloud.com/models/qwen3.8-max-0902'"],
		},
		doc: { href: "/docs/catalogs/#overlay-not-in-the-file", label: "Catalogs → overlay" },
		related: ["family", "desire", "pin"],
		lens: "closed",
	},
	{
		key: "desire",
		group: "The ledger",
		title: "Desire, have, who",
		lede: "The three human columns. Desire is priority; have is a fact about somebody's vault; who is how you find them.",
		body: [
			"Desire runs 1–9 and orders the board. It is also what `darsay archive --next` reads: a partial first, then the highest-desire source you do not have yet, skipping rows another collector has claimed. The note is the sentence that justifies the number — future you, and the friend who adopts this list, will read it.",
			"Have is a member's word that a complete bundle sits in their vault; who says whose — a name, a drive, a city. The CLI makes it a fact: reporting done flips the row to have and, if who is empty, fills in the client that finished it.",
			"The catalog this board exports carries source, revision, include, desire and note — intent. It never carries have, who or claims: those are this board's view of its members' vaults, and a friend overlays the same catalog on theirs.",
		],
		collect: "Rate honestly, write the sentence, and let --next do the ordering.",
		cmd: {
			label: "the next unfinished source",
			lines: [
				"darsay archive --next ./summer.json --max-gb 10   # straight from the downloaded file",
				"darsay catalog adopt summer ./summer.json         # or copy it into your vault first",
			],
		},
		doc: { href: "/docs/catalogs/#entry", label: "Catalogs → entry" },
		related: ["claims", "pin"],
		lens: "want",
	},
	{
		key: "claims",
		group: "The ledger",
		title: "Claims and the gauge",
		lede: "When a collector's CLI is fetching a row, the row says so — who, how far, and when it last spoke.",
		body: [
			"`darsay archive --next <board-url>` claims the row it picks before the first byte moves, then reports at the archive's own boundaries — start, a clean pause, registration — not per file. A gauge can sit at 1% all evening and still be live; the timestamp beside it says when it last reported. Other members see the row is spoken for, and their `--next` skips it.",
			"A claim goes stale after 24 hours without a report — a closed laptop, a lost network — and another collector's `--next` may take the row. Reporting done flips the row to have, and a row checked off as have is one `--next` never picks again; naming the source with `--board` is the deliberate way to re-fetch it. Claims live on the board only; the exported catalog never carries them.",
		],
		collect:
			"Two people fetching the same 700 GiB is the failure this exists to prevent. Let the CLI claim; edit have and who by hand only when the CLI could not.",
		cmd: {
			label: "claims, gauge, done",
			lines: ["darsay archive --next https://darsay.io/b/<board> --max-gb 10"],
		},
		doc: { href: "/docs/catalogs/#boards-darsayio", label: "Catalogs → boards" },
		related: ["desire", "large", "agents"],
		lens: "claimed",
	},
	{
		key: "agents",
		group: "The ledger",
		title: "The board, for programs",
		lede: "Everything on this page is one JSON document with stable row ids — readable at one address, writable through one API, and open to an agent through a key that never sees the URL.",
		body: [
			"Add `.json` to this board's address and a program gets the ledger: every row in desire order with its canonical `source` (the row's identity), its `address` and `lineage`, the chips, the claim, and a `revision` that changes on every write. `/openapi.json` describes every call; `/mcp` is the same board as an MCP server for Claude, ChatGPT, Codex and their kin, with an `explain` tool that opens this field guide.",
			"A row has no column to move between. Where a kanban card travels, a darsay row changes `desire` (which orders the list) or `status` (want → have). Adding is an upsert by address, so an agent can say *make sure this is on the board* as often as it likes; `apply` does that for a whole list in one transaction, with a dry run first. Dropping is undoable; removing is not.",
			"A key is this URL narrowed — one board, a few scopes (`read`, `write`, `claim`, `remove`), and a label that signs every write in the activity log. Mint one from the ✦ Agents panel, hand it to the agent instead of the URL, revoke it when the job is done. Nothing a key does can destroy a row unless you gave it `remove`.",
		],
		collect: "Give an agent a key, not the URL. Let it apply a list with a dry run first, then read the activity log — every change it made is there, before and after.",
		cmd: {
			label: "read the board",
			lines: ["curl -s https://darsay.io/b/<board>.json | jq '.entries[] | [.desire, .status, .source]'"],
		},
		doc: { href: "/docs/board/", label: "Docs → The board, for agents" },
		related: ["desire", "claims"],
	},
];

export const PRIMER_BY_KEY: Record<PrimerKey, PrimerCard> = Object.fromEntries(
	PRIMER.map((c) => [c.key, c]),
) as Record<PrimerKey, PrimerCard>;

export function primerCard(key: PrimerKey): PrimerCard {
	return PRIMER_BY_KEY[key];
}

export function primerIndex(key: PrimerKey): number {
	return PRIMER.findIndex((c) => c.key === key);
}

/** The card behind each of the CLI's hint chips. */
export const HINT_PRIMER: Record<string, PrimerKey> = {
	gated: "gated",
	large: "large",
	quant: "quant",
	redundant: "redundant",
	subset: "subset",
};

/**
 * The field guide: static teaching cards a board opens from its chips,
 * lenses, and facts. Authored copy only — rendered through `inline()`
 * (backticks → <code>), never from user text. Wording follows the docs;
 * every `doc` anchor is checked against `src/content/docs` in the tests.
 * Sizes are GiB, like the board and the CLI's own output.
 */
import type { LensKey } from "./lenses.ts";

export type PrimerKey =
	| "negatives"
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
	| "claims";

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
		key: "negatives",
		group: "Policy",
		title: "Negatives and prints",
		lede: "The `negatives` chip means this row is priced for the weights nothing can regenerate — the negatives — with the prints a script can remake left out.",
		body: [
			"Photography had the words first. A negative is the original exposure; a print is anything you can make from it again. darsay keeps the same line, and there is no third word. A **negative** is a weight set that cannot be re-derived — the full-fidelity BF16 or F16 safetensors, a native FP8 or MXFP4 release with no higher-fidelity public copy, a quant with calibration baked in, the only weight format a repo ships. A **print** is a mechanical transformation of a negative the repo also holds — a GGUF made by `llama-quantize` with no importance matrix, a shard byte-identical to one the bundle already keeps.",
			"`darsay archive` keeps the negatives by default. It reads a few tens of megabytes of headers from a multi-hundred-gigabyte repo, sorts every weight set into negative, print, support or unknown, and fetches everything except confident prints. Support files — config, tokenizer, license — always come along. Unknown means darsay will not guess, so the bytes are fetched.",
			"The skip is loud and on the record: the preflight names each print and its rule, the manifest keeps the full omitted inventory with sizes and hashes, and `--full` fetches the whole repo whenever you want the historical bytes people actually ran.",
		],
		collect:
			"Collect the negative. When disk forces a choice, it is the only file every future format can be built from.",
		cmd: {
			label: "the evidence table",
			lines: [
				"darsay classify owner/model",
				"darsay archive  owner/model          # the negatives, on the record",
				"darsay archive  owner/model --full   # every published byte instead",
			],
		},
		doc: {
			href: "/docs/quantization/#4-mechanics",
			label: "Quantization → mechanics",
		},
		related: ["quant", "dtype", "redundant", "formats"],
		lens: "negatives",
	},
	{
		key: "quant",
		group: "Formats",
		title: "Quants",
		lede: "A quant is a model stored with fewer bits per weight. Some are prints; some are negatives in their own right.",
		body: [
			"Full fidelity is the precision the weights were trained in — for today's models sixteen bits, BF16 or F16, two bytes a parameter. Quantization rounds those weights into eight, four, even two bits, trading a little accuracy for a lot of memory: a 27B model is about 52 GiB at BF16 and 15 GiB at Q4_K_M. The names encode the recipe. `Q4_K_M` is llama.cpp's 4-bit K-quant, medium; `IQ2_XS` a 2-bit importance-weighted one; `FP8`, `MXFP4`, `AWQ`, `GPTQ` and `NF4` are other families.",
			"What matters to a collector is not the bit count but the provenance. A **derived** quant is a mechanical cast of archived weights — regenerable from the negative under a recorded toolchain, so it is cache, not archive. A **published** quant is a repo in its own right and often cannot be regenerated bit-exact: AWQ and GPTQ need calibration data and a GPU run, an imatrix GGUF bakes in an importance matrix computed on a private corpus, an official FP8 is a curated layer map. When a model ships *only* in FP8 or MXFP4, that release is the negative.",
			"The `quant` chip is the CLI's verdict, never a guess from the name: the weight bytes are mostly GGUF, or the dominant safetensors dtype is below full fidelity.",
		],
		collect:
			"Archive the highest-fidelity release first. Keep a published quant as its own satellite bundle when it is the one people actually ran, or the only form that fits your hardware. Derive the rest at run time.",
		cmd: {
			label: "price the ecosystem",
			lines: [
				"darsay estimate owner/model --variants   # the quantized ecosystem, sized",
				"darsay archive  owner/model-FP8          # a published quant is an ordinary bundle",
			],
		},
		doc: { href: "/docs/quantization/#1-the-two-kinds-of-quantized-artifact", label: "Quantization → two kinds of quant" },
		related: ["negatives", "formats", "dtype", "subset"],
		lens: "quant",
	},
	{
		key: "formats",
		group: "Formats",
		title: "GGUF, safetensors, and the rest",
		lede: "The file extension tells you which loader the weights were made for — and, sometimes, whether they are a negative.",
		body: [
			"**safetensors** is the Hub's native format: a JSON header naming every tensor with its shape and dtype, then raw bytes. Big models shard into `model-00001-of-00028.safetensors` with a `model.safetensors.index.json` that says which shards make the loadable set. darsay reads that index, and a header only for a file no index accounts for — a few dozen kilobytes each — to classify a repo without downloading it.",
			"**GGUF** is llama.cpp's single-file container: a key/value header (architecture, context length, quantization level, and `quantize.imatrix.*` keys when an importance matrix was used) followed by the tensors. One repo often ships twenty of them at different levels — a pack. The pack is the wrong unit; `--include '*Q4_K_M*'` prices and archives one.",
			"The legacy formats — `.bin`, `.pt`, `.pth` — are PyTorch pickles; `.npz` is MLX. darsay refuses to guess about a legacy file beside safetensors and fetches it. A bundle's `model/` is a pristine Hub snapshot, so whatever loader the format implies — transformers, llama.cpp, MLX — opens it as a local directory.",
		],
		table: {
			head: ["File", "Made for", "What the header tells darsay"],
			rows: [
				["*.safetensors", "transformers, vLLM, MLX", "tensor names, shapes, dtype"],
				["*.gguf", "llama.cpp", "quant level, imatrix, source claims"],
				["*.bin · *.pt", "legacy PyTorch", "nothing — fetched, never skipped"],
			],
		},
		collect:
			"One safetensors negative beats a pack of GGUFs. Want the GGUF people actually ran? Archive that one file with --include, as a satellite.",
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
		lede: "Every size is parameters × bytes per parameter. The second factor is the precision the publisher released at — and it is why two models of the same size on paper can differ threefold on disk.",
		body: [
			"Every model row shows three numbers — `2.45T · BF16 · 2.00 B/param`: the parameter count, the release precision, and what the repo actually spends per weight. `BF16` and `F16` are two bytes a parameter; `F32` four; `FP8` and `INT8` one. A native 4-bit release — `MXFP4`, `NVFP4`, `AWQ INT4` — packs two weights into each byte plus a shared scale, about half a byte. The CLI reads the label from `config.json` (wherever a multimodal config nests it), the dominant dtype, or a GGUF's file name, and measures bytes per parameter from the priced bytes.",
			"So Qwen3.8-2.4T-A95B, 2.45T parameters at BF16, is 4.4 TiB and one negative set. Kimi-K3, 2.78T parameters at MXFP4, is 1.4 TiB. The second has *more* parameters and costs a third of the disk, because it was exposed at a quarter of the precision. Neither is bigger; both are negatives — a native low-precision release has no higher-fidelity public copy to prefer.",
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
			"Read the three numbers before the size. Near two bytes a parameter is one full-fidelity copy; near a half, a native 4-bit release; far above two, several weight sets in one box.",
		doc: { href: "/docs/catalogs/#estimate-digest", label: "Catalogs → the estimate digest" },
		related: ["negatives", "redundant", "quant", "formats"],
	},
	{
		key: "bundle",
		group: "Anatomy",
		title: "Anatomy of a bundle",
		lede: "One pinned revision of one source, stored as a museum record that is also a working checkout.",
		body: [
			"`model/` (or `data/` for a dataset) is the payload: a byte-exact Hub snapshot, frozen after archive. Load it the way you would load the original repo. Nothing under it is ever modified again.",
			"Beside it the tool writes what it established — `manifest.json` (facts, `null` where nothing was established, every query cap recorded), generated views like `README.md` and `VERIFICATION.md`, and `LICENSE` surfaced at the root. `curation.md` is the one file you write by hand; darsay never overwrites it.",
			"Anything needed to *run* the model — torch, llama-cpp, a Python environment — is hydration. It lives under `<vault>/.runtime/`, content-keyed and shared, and can be deleted at will. The bundle hash covers the payload only.",
		],
		collect:
			"The payload is the archive, the manifest is its provenance, and everything else is regenerable. Back up the folder and you have backed up all three.",
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
		related: ["pin", "dataset", "negatives"],
	},
	{
		key: "pin",
		group: "Anatomy",
		title: "The pin",
		lede: "archive does not mean “download main”. It means resolve, freeze, then transfer until every file verifies.",
		body: [
			"First the ref — `main`, a tag, a commit — resolves to an immutable revision. Then the file set is frozen: by default the negatives, with `--full` the whole repo, with `--include` exactly what you named. Only then do bytes move.",
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
			"The size on the row is the negative set where the CLI has classified the repo (the `negatives` chip), and the whole repo otherwise. Beside it, the precision and bytes per parameter say why it weighs what it weighs.",
		],
		collect: "Large is not a reason to skip — it is a reason to budget. The recipe card under each row writes the flags for you.",
		doc: { href: "/docs/examples/#pause-and-resume-a-large-archive", label: "Cookbook → pause and resume" },
		related: ["pin", "negatives", "dtype", "claims"],
		lens: "large",
	},
	{
		key: "gated",
		group: "Policy",
		title: "Gated",
		lede: "Some authors ask you to accept their terms before the files are served. darsay does not go around that.",
		body: [
			"A gated repo refuses anonymous requests. Accept the terms once on the model page, run `hf auth login` once on the machine, and every darsay verb works as before — the gate is enforced server-side; darsay carries your token, it does not forge one.",
			"Gating has a cost the board can see. Until you are signed in, darsay cannot read a gated file's header, so `estimate` prices the whole repo and `classify` marks every weight set `unknown` — which means fetched, never skipped.",
		],
		collect: "Accept the terms while the author is still there to grant them. A gate that closes later is one more way a repo vanishes.",
		cmd: {
			label: "once per machine",
			lines: ["hf auth login                 # after accepting the terms on huggingface.co", "darsay archive owner/model"],
		},
		doc: { href: "/docs/catalogs/#hints", label: "Catalogs → hints" },
		related: ["negatives", "pin"],
		lens: "gated",
	},
	{
		key: "redundant",
		group: "Policy",
		title: "Redundant",
		lede: "The repo weighs far more than one copy of its own parameter count: it ships several weight sets.",
		body: [
			"The smell is arithmetic. `estimate` multiplies the published per-dtype parameter counts by their widths to get one copy's weight bytes; when the repo's weight files total 1.75× that or more, the row gets `redundant`. An exact second copy is 2.0×.",
			"What the extra bytes *are* is the interesting part. Sometimes a BF16 negative plus every GGUF of it — prints, skipped by default. Sometimes a multi-pipeline repo shipping the same 60 GiB text encoder three times — byte-identical twins, kept once. Sometimes two *different* builds under one index and an orphaned shard set nobody references — undecidable, so fetched in full.",
			"`darsay classify` lays the sets out with rule ids and evidence. The case that motivated it: a 27.78B abliterated Qwen weighing 223 GiB against a 51.7 GiB base.",
		],
		collect:
			"Redundant is an invitation to look, not a verdict. Run classify; keep what it calls negative or unknown; let it skip confident prints.",
		cmd: {
			label: "what is in the box",
			lines: [
				"darsay classify owner/model",
				"darsay estimate owner/model            # priced as the negative set",
				"darsay estimate owner/model --full     # the shipping box",
			],
		},
		doc: {
			href: "/docs/quantization/#4-mechanics",
			label: "Quantization → mechanics",
		},
		related: ["dtype", "negatives", "quant"],
		lens: "redundant",
	},
	{
		key: "subset",
		group: "Policy",
		title: "Subsets",
		lede: "--include freezes exactly the files you name, plus the sidecars a single file needs to load.",
		body: [
			"Pack repos make “bundle = whole repo” the wrong unit: twenty GGUFs, one of which you want. `--include` is a glob, repeatable; a leading `/` anchors it to the repo root. Matching files are kept, plus config, tokenizer, license and card, so the one file still loads.",
			"The pin is the subset. Later reruns without `--include` resume it rather than expand it. The manifest records the subset honestly — the include patterns and the full upstream inventory with sizes and hashes — so the bundle states what it deliberately does not contain.",
		],
		collect:
			"Use a subset for packs and for satellites. For a model you are preserving, prefer the default: the negatives, with the prints already skipped.",
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
		lede: "A model whose refusal behaviour was surgically removed from the weights — ablated, then obliterated: abliterated.",
		body: [
			"The technique follows a 2024 finding that refusal in chat models is mediated by a single direction in activation space. Find that direction with a few hundred harmful and harmless prompts, project it out of the weight matrices, and the model stops declining without any fine-tuning — its knowledge is still the base model's; only the reflex is gone. Community releases carry it in the name — *abliterated*, or a coinage like *OBLITERATED* or *heretic*. (*Uncensored* usually means a fine-tune on permissive data: a different operation, the same collecting logic.)",
			"For a collector these are a distinct kind of artifact. The edit is a one-way operation in weight space, and the prompt sets that found the direction are usually unpublished — so the result cannot be regenerated from the base. In darsay's terms they are negatives, not prints, even though they descend from a model you may already hold.",
			"The repo that motivated `classify` was one of these, and a messy one: two differing weight sets, GGUFs whose headers named a build that was never published, provenance that disagreed with itself. `classify` refuses to guess in exactly those cases and fetches everything undecidable; the `redundant` chip is often the first sign.",
		],
		collect:
			"Collect the base and the abliteration as two negatives of one lineage: the base for what the model knows, the abliteration for a form of it that nothing can rebuild.",
		link: {
			href: "https://arxiv.org/abs/2406.11717",
			label: "Arditi et al., 2024 — Refusal in language models is mediated by a single direction",
		},
		doc: { href: "/docs/quantization/#2-policy", label: "Quantization → policy" },
		related: ["negatives", "family", "redundant", "base"],
		lens: "abliterated",
	},
	{
		key: "base",
		group: "Names",
		title: "Base vs. post-trained",
		lede: "A base model has only been pretrained. Everything you would actually talk to was trained further on top of one.",
		body: [
			"Pretraining reads trillions of tokens and produces a model that completes text — the base, usually suffixed `-Base` or `-pt`. Post-training (instruction tuning, RLHF, distillation) turns it into the `-Instruct`, `-Chat` or unsuffixed release that answers questions. The base is published separately, when it is published at all.",
			"The base is the root of the lineage: the artifact a future team would need to restart development — continue pretraining, fine-tune for a new task, distill a smaller model. An instruct release is one branch. Neither can be derived from the other.",
		],
		collect:
			"For a model family you care about, keep one base and the post-trained release you use. The base is the seed; the instruct is the harvest.",
		related: ["abliterated", "family", "moe", "negatives"],
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
			"The draft comes in three shapes on the Hub. A separate small model of the same family and tokenizer (`Qwen3-0.6B` drafting for `Qwen3-32B`). A trained head bolted onto the target — **EAGLE**, **Medusa**, **HASS** — published as its own small repo (`…-speculator.eagle3`, `EAGLE3-…`), useless without the exact target it was trained against. Or **MTP** layers — multi-token prediction — shipped inside the main repo, as DeepSeek-V3, GLM-4.5 and Qwen3-Next do; those are part of the master weights and ride along in every darsay archive, so they need no row of their own.",
			"Vocabulary is the contract: draft and target must share a tokenizer, and a head was trained on one target's hidden states. Pair them in the same catalog at the same desire. A draft alone is a curiosity; a head alone is a paperweight.",
		],
		collect:
			"Collect drafts and heads beside their targets. They are small, they are trained artifacts nothing regenerates, and they are what makes a trillion-parameter model usable on the hardware you actually have.",
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
		related: ["desire", "large"],
		lens: "claimed",
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

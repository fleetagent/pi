import { visibleWidth } from "./utils.ts";

const SYMBOLS: Readonly<Record<string, string>> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	cdot: "·",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "•",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	bigcirc: "○",
	dagger: "†",
	ddagger: "‡",
	amalg: "⨿",
	uplus: "⊎",
	sqcap: "⊓",
	sqcup: "⊔",
	triangleleft: "◁",
	triangleright: "▷",
	wr: "≀",
	cap: "∩",
	cup: "∪",
	bigcap: "⋂",
	bigcup: "⋃",
	bigwedge: "⋀",
	bigvee: "⋁",
	bigsqcup: "⨆",
	biguplus: "⨄",
	bigoplus: "⨁",
	bigotimes: "⨂",
	bigodot: "⨀",
	setminus: "∖",
	in: "∈",
	notin: "∉",
	ni: "∋",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	prec: "≺",
	preceq: "≼",
	succ: "≻",
	succeq: "≽",
	ll: "≪",
	gg: "≫",
	le: "≤",
	leq: "≤",
	leqslant: "≤",
	ge: "≥",
	geq: "≥",
	geqslant: "≥",
	ne: "≠",
	neq: "≠",
	equiv: "≡",
	approx: "≈",
	sim: "∼",
	simeq: "≃",
	cong: "≅",
	asymp: "≍",
	doteq: "≐",
	propto: "∝",
	parallel: "∥",
	perp: "⊥",
	mid: "∣",
	vdash: "⊢",
	dashv: "⊣",
	models: "⊨",
	Vdash: "⊩",
	Vvdash: "⊪",
	nvdash: "⊬",
	nvDash: "⊭",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	neg: "¬",
	land: "∧",
	wedge: "∧",
	lor: "∨",
	vee: "∨",
	to: "→",
	rightarrow: "→",
	longrightarrow: "→",
	leftarrow: "←",
	longleftarrow: "←",
	gets: "←",
	leftrightarrow: "↔",
	longleftrightarrow: "↔",
	hookleftarrow: "↩",
	hookrightarrow: "↪",
	twoheadleftarrow: "↞",
	twoheadrightarrow: "↠",
	leftharpoonup: "↼",
	leftharpoondown: "↽",
	rightharpoonup: "⇀",
	rightharpoondown: "⇁",
	rightleftharpoons: "⇌",
	leftrightharpoons: "⇋",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	rightsquigarrow: "⇝",
	leadsto: "⇝",
	Rightarrow: "⇒",
	Longrightarrow: "⇒",
	Leftarrow: "⇐",
	Longleftarrow: "⇐",
	Leftrightarrow: "⇔",
	Longleftrightarrow: "⇔",
	implies: "⇒",
	iff: "⇔",
	mapsto: "↦",
	longmapsto: "↦",
	uparrow: "↑",
	downarrow: "↓",
	partial: "∂",
	nabla: "∇",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	oint: "∮",
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	infty: "∞",
	emptyset: "∅",
	varnothing: "∅",
	angle: "∠",
	therefore: "∴",
	because: "∵",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	top: "⊤",
	bot: "⊥",
	triangle: "△",
	square: "□",
	lozenge: "◊",
	checkmark: "✓",
	complement: "∁",
	wp: "℘",
	prime: "′",
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	ell: "ℓ",
	hbar: "ℏ",
	Im: "ℑ",
	Re: "ℜ",
	langle: "⟨",
	rangle: "⟩",
	vert: "|",
	lvert: "|",
	rvert: "|",
	Vert: "‖",
	lVert: "‖",
	rVert: "‖",
	lbrace: "{",
	rbrace: "}",
	backslash: "\\",
	lfloor: "⌊",
	rfloor: "⌋",
	lceil: "⌈",
	rceil: "⌉",
	colon: ":",
};

const NAMED_OPERATORS = new Set([
	"arccos",
	"arcsin",
	"arctan",
	"arg",
	"cos",
	"cosh",
	"cot",
	"coth",
	"csc",
	"deg",
	"det",
	"dim",
	"exp",
	"gcd",
	"hom",
	"inf",
	"ker",
	"lg",
	"lim",
	"liminf",
	"limsup",
	"ln",
	"log",
	"max",
	"min",
	"Pr",
	"sec",
	"sin",
	"sinh",
	"sup",
	"tan",
	"tanh",
]);

const LIMIT_OPERATORS = new Set([
	"argmax",
	"argmin",
	"inf",
	"injlim",
	"lim",
	"liminf",
	"limsup",
	"max",
	"min",
	"projlim",
	"sup",
]);

const DISPLAY_LIMIT_SYMBOLS = new Set([
	"bigcap",
	"bigcup",
	"bigodot",
	"bigoplus",
	"bigotimes",
	"bigsqcup",
	"biguplus",
	"bigvee",
	"bigwedge",
	"coprod",
	"int",
	"iint",
	"iiint",
	"oint",
	"prod",
	"sum",
]);

const RELATION_COMMANDS = new Set([
	"Leftarrow",
	"Leftrightarrow",
	"Longleftarrow",
	"Longleftrightarrow",
	"Longrightarrow",
	"Rightarrow",
	"Vdash",
	"Vvdash",
	"approx",
	"asymp",
	"cong",
	"dashv",
	"doteq",
	"downarrow",
	"equiv",
	"ge",
	"geq",
	"geqslant",
	"gets",
	"gg",
	"hookleftarrow",
	"hookrightarrow",
	"iff",
	"implies",
	"in",
	"leadsto",
	"le",
	"leftarrow",
	"leftharpoondown",
	"leftharpoonup",
	"leftrightarrow",
	"leftrightharpoons",
	"leq",
	"leqslant",
	"ll",
	"longleftarrow",
	"longleftrightarrow",
	"longmapsto",
	"longrightarrow",
	"mapsto",
	"mid",
	"models",
	"ne",
	"nearrow",
	"neq",
	"ni",
	"notin",
	"nvdash",
	"nvDash",
	"nwarrow",
	"parallel",
	"perp",
	"prec",
	"preceq",
	"propto",
	"rightharpoondown",
	"rightharpoonup",
	"rightleftharpoons",
	"rightarrow",
	"rightsquigarrow",
	"searrow",
	"sim",
	"simeq",
	"sqsubset",
	"sqsubseteq",
	"sqsupset",
	"sqsupseteq",
	"subset",
	"subseteq",
	"succ",
	"succeq",
	"supset",
	"supseteq",
	"swarrow",
	"to",
	"triangleleft",
	"triangleright",
	"twoheadleftarrow",
	"twoheadrightarrow",
	"uparrow",
	"vdash",
]);

const NEGATED_SYMBOLS: Readonly<Record<string, string>> = {
	"<": "≮",
	">": "≯",
	"=": "≠",
	"∈": "∉",
	"∋": "∌",
	"∣": "∤",
	"∥": "∦",
	"∼": "≁",
	"≃": "≄",
	"≅": "≇",
	"≈": "≉",
	"≡": "≢",
	"≤": "≰",
	"≥": "≱",
	"≺": "⊀",
	"≻": "⊁",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"⊢": "⊬",
	"⊨": "⊭",
	"↔": "↮",
	"←": "↚",
	"→": "↛",
	"⇒": "⇏",
	"⇐": "⇍",
	"⇔": "⇎",
	"≼": "⋠",
	"≽": "⋡",
};

const BLACKBOARD: Readonly<Record<string, string>> = {
	C: "ℂ",
	H: "ℍ",
	N: "ℕ",
	P: "ℙ",
	Q: "ℚ",
	R: "ℝ",
	Z: "ℤ",
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

const SPACING_COMMANDS = new Set([
	",",
	":",
	";",
	" ",
	">",
	"enspace",
	"enskip",
	"medspace",
	"quad",
	"qquad",
	"thickspace",
	"thinspace",
]);
const NEGATIVE_SPACING_COMMANDS = new Set(["!", "negmedspace", "negthickspace", "negthinspace"]);
const NEGATIVE_SPACE = "\u0000";
const IGNORED_COMMANDS = new Set([
	"displaystyle",
	"limits",
	"nolimits",
	"scriptstyle",
	"scriptscriptstyle",
	"textstyle",
]);
const SIZE_COMMANDS = new Set([
	"big",
	"Big",
	"bigg",
	"Bigg",
	"bigl",
	"Bigl",
	"biggl",
	"Biggl",
	"bigr",
	"Bigr",
	"biggr",
	"Biggr",
]);
const LITERAL_COMMANDS = new Set(["{", "}", "$", "%", "#", "_", "&"]);
const DELIMITER_COMMANDS = new Set(["left", "middle", "right"]);
const PLAIN_WRAPPERS = new Set([
	"emph",
	"mathcal",
	"mathbf",
	"mathfrak",
	"mathit",
	"mathrm",
	"mathnormal",
	"mathscr",
	"mathsf",
	"mathtt",
	"mathup",
	"mbox",
	"overbrace",
	"pmb",
	"smash",
	"substack",
	"text",
	"textbf",
	"textit",
	"textmd",
	"textnormal",
	"textrm",
	"textsc",
	"textsf",
	"textsl",
	"texttt",
	"textup",
	"underbrace",
	"bm",
	"boldsymbol",
]);
const ACCENTS: Readonly<Record<string, string>> = {
	acute: "\u0301",
	bar: "\u0305",
	breve: "\u0306",
	check: "\u030c",
	ddot: "\u0308",
	dot: "\u0307",
	grave: "\u0300",
	hat: "\u0302",
	mathring: "\u030a",
	overleftarrow: "\u20d6",
	overleftrightarrow: "\u20e1",
	overline: "\u0305",
	overrightarrow: "\u20d7",
	tilde: "\u0303",
	underline: "\u0332",
	vec: "\u20d7",
	widehat: "\u0302",
	widetilde: "\u0303",
};

type MathScriptKind = "sub" | "sup";
type OperatorScriptMarker = "_" | "^";
type InlineOperatorLowerStyle = "bracket" | "script";

function replaceCharacters(value: string, replacements: Readonly<Record<string, string>>): string | undefined {
	let result = "";
	for (const character of value) {
		const replacement = replacements[character];
		if (replacement === undefined) {
			return undefined;
		}
		result += replacement;
	}
	return result;
}

function formatScript(value: string, kind: MathScriptKind): string {
	value = value.trim();
	const replacements = kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS;
	const unicode = replaceCharacters(value.replace(/\s*([=+-])\s*/g, "$1"), replacements);
	if (unicode !== undefined) {
		return unicode;
	}

	const prefix = kind === "sub" ? "_" : "^";
	if (Array.from(value).length === 1 || (kind === "sub" && /^[A-Za-z]+$/.test(value))) {
		return `${prefix}${value}`;
	}
	return `${prefix}(${value})`;
}

function formatFraction(numerator: string, denominator: string): string {
	numerator = numerator.trim();
	denominator = denominator.trim();
	const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
	const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
	return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
}

function formatRoot(value: string, symbol = "√"): string {
	value = value.trim();
	return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
}

const NAMED_OPERATOR_START = "\u{f0004}";
const NAMED_OPERATOR_END = "\u{f0005}";
const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;

function normalizeOutput(value: string): string {
	return value
		.replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ")
		.replaceAll(NAMED_OPERATOR_START, "")
		.replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ")
		.replaceAll(NAMED_OPERATOR_END, "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
		.join("\n")
		.trim();
}

interface FractionNode {
	type: "fraction";
	numerator: string;
	denominator: string;
}

interface OperatorNode {
	type: "operator";
	operator: string;
	lower?: string;
	upper?: string;
}

interface ParsedOperatorScripts {
	lower?: string;
	upper?: string;
}

interface MatrixNode {
	type: "matrix";
	lines: string[];
	baseline: number;
}

type LayoutNode = FractionNode | OperatorNode | MatrixNode;

interface Layout {
	lines: string[];
	width: number;
	baseline: number;
}

const LAYOUT_MARKER_START = "\u{f0000}";
const LAYOUT_MARKER_END = "\u{f0001}";
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
const PROTECTED_SPACE = "\u{f0002}";
const RESERVED_MARKER_PATTERN = /[\u{f0000}\u{f0001}\u{f0002}\u{f0004}\u{f0005}]/u;
const MAX_SOURCE_LENGTH = 16 * 1024;
const MAX_NESTING_DEPTH = 64;
const MAX_LAYOUT_NODES = 256;
const MAX_RENDERED_ROWS = 200;
const MAX_RENDERED_LINE_WIDTH = 4096;

interface LatexParseState {
	nestingDepth: number;
}

type LatexSequenceCharacterKind =
	| "end"
	| "unexpected-close"
	| "group"
	| "command"
	| "script"
	| "whitespace"
	| "relation"
	| "alignment"
	| "space"
	| "period"
	| "literal";

function classifyLatexSequenceCharacter(character: string, endCharacter?: string): LatexSequenceCharacterKind {
	if (endCharacter && character === endCharacter) return "end";
	switch (character) {
		case "}":
			return "unexpected-close";
		case "{":
			return "group";
		case "\\":
			return "command";
		case "^":
		case "_":
			return "script";
		case "=":
		case "<":
		case ">":
			return "relation";
		case "&":
			return "alignment";
		case "~":
			return "space";
		case ".":
			return "period";
		default:
			return /\s/.test(character) ? "whitespace" : "literal";
	}
}

function assertLayoutBounds(width: number, rowCount: number): void {
	if (
		!Number.isSafeInteger(width) ||
		width < 0 ||
		width > MAX_RENDERED_LINE_WIDTH ||
		!Number.isSafeInteger(rowCount) ||
		rowCount < 0 ||
		rowCount > MAX_RENDERED_ROWS
	) {
		throw new RangeError("LaTeX layout exceeds renderer bounds");
	}
}

function padLayoutLine(line: string, width: number, centered = false): string {
	const padding = Math.max(0, width - visibleWidth(line));
	const left = centered ? Math.floor(padding / 2) : 0;
	return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

// pi-ignore noExcessiveCollectionIterations: Every output row must concatenate every layout segment; rows are capped at 200 and parsed layout nodes at 256.
function joinLayouts(layouts: readonly Layout[]): Layout {
	if (layouts.length === 0) {
		return { lines: [""], width: 0, baseline: 0 };
	}
	const baseline = Math.max(...layouts.map((layout) => layout.baseline));
	const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
	const width = layouts.reduce((total, layout) => total + layout.width, 0);
	const rowCount = baseline + below + 1;
	assertLayoutBounds(width, rowCount);
	const lines: string[] = [];
	for (let row = 0; row < rowCount; row++) {
		let line = "";
		for (const layout of layouts) {
			const sourceRow = row - baseline + layout.baseline;
			line +=
				sourceRow >= 0 && sourceRow < layout.lines.length
					? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
					: " ".repeat(layout.width);
		}
		lines.push(line.trimEnd());
	}
	return { lines, width, baseline };
}

function createTextLayout(text: string): Layout {
	return { lines: [text], width: visibleWidth(text), baseline: 0 };
}

function createInterNodeTextLayout(source: string, previousNode: LayoutNode | undefined, nextNode: LayoutNode): Layout {
	const trimmed = (previousNode ? source.trimStart() : source).trimEnd();
	const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(source);
	const preserveTrailingSpace = nextNode.type === "matrix" && /\s$/.test(source);
	const text = trimmed
		? `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`
		: preserveLeadingSpace || preserveTrailingSpace
			? " "
			: "";
	return createTextLayout(text);
}

function createTrailingTextLayout(source: string, previousNode: LayoutNode | undefined): Layout {
	const trimmed = previousNode ? source.trimStart() : source;
	const text = previousNode?.type === "matrix" && /^\s/.test(source) ? ` ${trimmed}` : trimmed;
	return createTextLayout(text);
}

function renderFractionNodeLayout(node: FractionNode, nodes: readonly LayoutNode[]): Layout {
	const numerator = renderLayout(node.numerator, nodes);
	const denominator = renderLayout(node.denominator, nodes);
	const contentWidth = Math.max(numerator.width, denominator.width, 1);
	const width = contentWidth + 2;
	const lines = [
		...numerator.lines.map((line) => padLayoutLine(line, width, true)),
		` ${"─".repeat(contentWidth)} `,
		...denominator.lines.map((line) => padLayoutLine(line, width, true)),
	];
	assertLayoutBounds(width, lines.length);
	return { lines, width, baseline: numerator.lines.length };
}

function renderOperatorNodeLayout(node: OperatorNode): Layout {
	const contentWidth = Math.max(
		visibleWidth(node.operator),
		node.lower === undefined ? 0 : visibleWidth(node.lower),
		node.upper === undefined ? 0 : visibleWidth(node.upper),
	);
	const lines: string[] = [];
	if (node.upper !== undefined) lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
	lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
	if (node.lower !== undefined) lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
	assertLayoutBounds(contentWidth + 1, lines.length);
	return { lines, width: contentWidth + 1, baseline: node.upper === undefined ? 0 : 1 };
}

function renderMatrixNodeLayout(node: MatrixNode): Layout {
	const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
	assertLayoutBounds(width, node.lines.length);
	return {
		lines: node.lines.map((line) => padLayoutLine(line, width)),
		width,
		baseline: node.baseline,
	};
}

function renderLayoutNode(node: LayoutNode, nodes: readonly LayoutNode[]): Layout {
	switch (node.type) {
		case "fraction":
			return renderFractionNodeLayout(node, nodes);
		case "operator":
			return renderOperatorNodeLayout(node);
		case "matrix":
			return renderMatrixNodeLayout(node);
	}
}

function renderSourceLineLayout(sourceLine: string, nodes: readonly LayoutNode[]): Layout {
	const layouts: Layout[] = [];
	let position = 0;
	let previousNode: LayoutNode | undefined;
	for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
		const index = match.index;
		const node = nodes[Number(match[1])];
		if (!node) continue;
		if (index > position) {
			layouts.push(createInterNodeTextLayout(sourceLine.slice(position, index), previousNode, node));
		}
		layouts.push(renderLayoutNode(node, nodes));
		position = index + match[0].length;
		previousNode = node;
	}
	if (position < sourceLine.length) {
		layouts.push(createTrailingTextLayout(sourceLine.slice(position), previousNode));
	}
	return joinLayouts(layouts);
}

function renderLayout(source: string, nodes: readonly LayoutNode[]): Layout {
	const renderedLines: string[] = [];
	let firstBaseline = 0;
	for (const sourceLine of source.split("\n")) {
		const lineLayout = renderSourceLineLayout(sourceLine, nodes);
		if (renderedLines.length === 0) firstBaseline = lineLayout.baseline;
		renderedLines.push(...lineLayout.lines);
		assertLayoutBounds(0, renderedLines.length);
	}
	const width = Math.max(0, ...renderedLines.map((line) => visibleWidth(line)));
	assertLayoutBounds(width, renderedLines.length);
	return { lines: renderedLines, width, baseline: firstBaseline };
}

class LatexParser {
	private readonly source: string;
	private readonly layoutNodes: LayoutNode[];
	private readonly display: boolean;
	private readonly state: LatexParseState;
	private position = 0;
	private supported = true;
	private stackFractions = true;

	constructor(
		source: string,
		layoutNodes: LayoutNode[],
		display: boolean,
		state: LatexParseState = { nestingDepth: 0 },
	) {
		this.source = source;
		this.layoutNodes = layoutNodes;
		this.display = display;
		this.state = state;
	}

	render(): string | undefined {
		const rendered = this.parseSequence();
		if (!this.supported || this.position !== this.source.length) {
			return undefined;
		}
		return normalizeOutput(rendered);
	}

	private appendParsedCommand(result: string): string {
		const command = this.parseCommand();
		if (command !== NEGATIVE_SPACE) return result + command;
		const trimmed = result.trimEnd();
		return trimmed.endsWith(NAMED_OPERATOR_END) ? trimmed.slice(0, -NAMED_OPERATOR_END.length) : trimmed;
	}

	private appendParsedScript(result: string, character: string): string {
		this.position++;
		const trimmed = result.trimEnd();
		const script = formatScript(this.parseRequiredArgument(false), character === "_" ? "sub" : "sup");
		return trimmed.endsWith(NAMED_OPERATOR_END)
			? `${trimmed.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`
			: trimmed + script;
	}

	private appendPeriod(result: string): string {
		const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
		const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
		if (node?.type === "matrix") {
			const lastLine = node.lines.length - 1;
			node.lines[lastLine] = `${node.lines[lastLine] ?? ""}.`;
			this.position++;
			return result;
		}
		this.position++;
		return `${result}.`;
	}

	private parseSequence(endCharacter?: string): string {
		let result = "";
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			switch (classifyLatexSequenceCharacter(character, endCharacter)) {
				case "end":
					this.position++;
					return result;
				case "unexpected-close":
					this.supported = false;
					return result;
				case "group":
					this.position++;
					result += this.parseNestedSequence("}");
					break;
				case "command":
					result = this.appendParsedCommand(result);
					break;
				case "script":
					result = this.appendParsedScript(result, character);
					break;
				case "whitespace":
					result += this.parseWhitespace();
					break;
				case "relation":
					result = `${result.trimEnd()} ${character} `;
					this.position++;
					break;
				case "alignment":
					this.position++;
					break;
				case "space":
					this.position++;
					result += " ";
					break;
				case "period":
					result = this.appendPeriod(result);
					break;
				case "literal":
					result += character;
					this.position++;
					break;
			}
		}
		if (endCharacter) this.supported = false;
		return result;
	}

	private parseWhitespace(): string {
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		return " ";
	}

	private readCommandName(): string | undefined {
		this.position++;
		if (this.position >= this.source.length) {
			this.supported = false;
			return undefined;
		}

		const first = this.source[this.position] ?? "";
		if (!/[A-Za-z]/.test(first)) {
			this.position++;
			return first;
		}
		const start = this.position;
		while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		return this.source.slice(start, this.position);
	}

	private parsePredefinedCommand(command: string): string | undefined {
		if (command === "\\") return "\n";
		if (SPACING_COMMANDS.has(command)) return " ";
		if (NEGATIVE_SPACING_COMMANDS.has(command)) return NEGATIVE_SPACE;
		if (IGNORED_COMMANDS.has(command)) return "";
		if (LITERAL_COMMANDS.has(command)) return command;
		if (command === "|") return "‖";
		return undefined;
	}

	private parseNegatedCommand(): string {
		const value = this.parseRequiredArgument(false).trim();
		const negated = NEGATED_SYMBOLS[value];
		if (negated !== undefined) return ` ${negated} `;

		const characters = Array.from(value);
		if (characters.length === 0) {
			this.supported = false;
			return "";
		}
		return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
	}

	private parseSymbolCommand(command: string): string | undefined {
		const symbol = SYMBOLS[command];
		if (symbol === undefined) return undefined;
		if (DISPLAY_LIMIT_SYMBOLS.has(command)) return this.parseOperator(symbol, "script", true);
		return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
	}

	private parseNamedOrDelimiterCommand(command: string): string | undefined {
		if (NAMED_OPERATORS.has(command)) return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
		if (SIZE_COMMANDS.has(command)) return "";
		if (!DELIMITER_COMMANDS.has(command)) return undefined;
		if (this.source[this.position] === ".") this.position++;
		return "";
	}

	private parseFractionCommand(command: string): string {
		const shouldStack = this.display && this.stackFractions && command !== "tfrac";
		const numerator = this.parseRequiredArgument(!shouldStack);
		const denominator = this.parseRequiredArgument(!shouldStack);
		if (!shouldStack) return formatFraction(numerator, denominator);

		const index = this.addLayoutNode({
			type: "fraction",
			numerator: normalizeOutput(numerator),
			denominator: normalizeOutput(denominator),
		});
		return index === undefined ? "" : `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	private parseRootCommand(): string {
		const degree = this.parseOptionalArgument()?.trim();
		const value = this.parseRequiredArgument();
		if (degree === undefined || degree === "2") return formatRoot(value);
		if (degree === "3") return formatRoot(value, "∛");
		if (degree === "4") return formatRoot(value, "∜");
		return `${formatScript(degree, "sup")}${formatRoot(value)}`;
	}

	private parseAccentCommand(command: string, accent: string): string {
		const value = this.parseRequiredArgument();
		return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
	}

	private parseOperatorNameCommand(): string {
		const starred = this.source[this.position] === "*";
		if (starred) this.position++;
		const operator = normalizeOutput(this.parseRequiredArgument()).trim();
		return this.parseOperator(operator, "bracket", starred, true);
	}

	private parseArgumentCommand(command: string): string | undefined {
		switch (command) {
			case "frac":
			case "dfrac":
			case "tfrac":
				return this.parseFractionCommand(command);
			case "sqrt":
				return this.parseRootCommand();
			case "boxed":
			case "fbox":
				return `[${this.parseRequiredArgument().trim()}]`;
			case "binom":
			case "dbinom":
			case "tbinom":
				return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
			case "mathbb": {
				const value = this.parseRequiredArgument();
				return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
			}
			case "operatorname":
				return this.parseOperatorNameCommand();
			case "mod":
			case "bmod":
				return " mod ";
			case "pmod":
			case "pod": {
				const value = this.parseRequiredArgument().trim();
				return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
			}
			case "overset":
			case "stackrel": {
				const upper = this.parseRequiredArgument();
				const value = this.parseRequiredArgument().trim();
				return `${value}${formatScript(upper, "sup")}`;
			}
			case "underset": {
				const lower = this.parseRequiredArgument();
				const value = this.parseRequiredArgument().trim();
				return `${value}${formatScript(lower, "sub")}`;
			}
			case "begin":
				return this.parseEnvironment();
			case "end":
				this.supported = false;
				return "";
		}

		const accent = ACCENTS[command];
		if (accent !== undefined) return this.parseAccentCommand(command, accent);
		if (PLAIN_WRAPPERS.has(command)) {
			const value = this.parseRequiredArgument();
			return command.startsWith("text") || command === "mbox" ? value : value.trim();
		}
		return undefined;
	}

	private parseCommand(): string {
		const command = this.readCommandName();
		if (command === undefined) return "";

		const predefined = this.parsePredefinedCommand(command);
		if (predefined !== undefined) return predefined;
		if (command === "not") return this.parseNegatedCommand();
		if (LIMIT_OPERATORS.has(command)) return this.parseOperator(command, "bracket", true, true);

		const symbol = this.parseSymbolCommand(command);
		if (symbol !== undefined) return symbol;
		const namedOrDelimiter = this.parseNamedOrDelimiterCommand(command);
		if (namedOrDelimiter !== undefined) return namedOrDelimiter;
		const argumentCommand = this.parseArgumentCommand(command);
		if (argumentCommand !== undefined) return argumentCommand;

		this.supported = false;
		return `\\${command}`;
	}

	private assignOperatorScript(scripts: ParsedOperatorScripts, kind: OperatorScriptMarker, value: string): void {
		const property = kind === "_" ? "lower" : "upper";
		if (scripts[property] !== undefined) this.supported = false;
		scripts[property] = value;
	}

	private parseOperatorDisplayLimits(displayLimits: boolean): boolean {
		let modifierPosition = this.position;
		while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
			modifierPosition++;
		}
		const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
		if (!modifier) return displayLimits;
		this.position = modifierPosition + modifier[0].length;
		return modifier[1] === "limits";
	}

	private parseOperatorScripts(): ParsedOperatorScripts {
		const scripts: ParsedOperatorScripts = {};
		while (true) {
			let scriptPosition = this.position;
			while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
				scriptPosition++;
			}
			const kind = this.source[scriptPosition];
			if (kind !== "_" && kind !== "^") break;
			this.position = scriptPosition + 1;
			const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
			this.assignOperatorScript(scripts, kind, value);
		}
		return scripts;
	}

	private parseOperator(
		operator: string,
		inlineLowerStyle: InlineOperatorLowerStyle,
		displayLimits: boolean,
		spaced = false,
	): string {
		const useDisplayLimits = this.parseOperatorDisplayLimits(displayLimits);
		const { lower, upper } = this.parseOperatorScripts();
		if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
			const index = this.addLayoutNode({ type: "operator", operator, lower, upper });
			return index === undefined ? "" : `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
		}

		let rendered = operator;
		if (lower !== undefined) {
			rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
		}
		if (upper !== undefined) rendered += formatScript(upper, "sup");
		return spaced ? ` ${rendered} ` : rendered;
	}

	private parseRequiredArgument(stackFractions = true): string {
		const previousStackFractions = this.stackFractions;
		this.stackFractions = previousStackFractions && stackFractions;
		const value = this.parseRequiredArgumentValue();
		this.stackFractions = previousStackFractions;
		return value;
	}

	private parseRequiredArgumentValue(): string {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.position >= this.source.length) {
			this.supported = false;
			return "";
		}
		if (this.source[this.position] === "{") {
			this.position++;
			return this.parseNestedSequence("}");
		}
		if (this.source[this.position] === "\\") {
			return this.parseCommand();
		}
		const value = this.source[this.position] ?? "";
		this.position++;
		return value;
	}

	private parseOptionalArgument(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "[") {
			return undefined;
		}
		const end = this.source.indexOf("]", this.position + 1);
		if (end < 0) {
			this.supported = false;
			return undefined;
		}
		const value = this.source.slice(this.position + 1, end);
		this.position = end + 1;
		return this.renderNested(value);
	}

	private readRawGroupContents(start: number): string | undefined {
		let depth = 1;
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			if (character === "\\") {
				this.position += 2;
				continue;
			}
			if (character === "{") {
				depth++;
				if (this.state.nestingDepth + depth > MAX_NESTING_DEPTH) {
					this.supported = false;
					return undefined;
				}
				this.position++;
				continue;
			}
			if (character !== "}") {
				this.position++;
				continue;
			}
			depth--;
			if (depth > 0) {
				this.position++;
				continue;
			}
			const value = this.source.slice(start, this.position);
			this.position++;
			return value;
		}
		this.supported = false;
		return undefined;
	}

	private readRawGroup(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "{") {
			this.supported = false;
			return undefined;
		}

		const start = ++this.position;
		if (this.state.nestingDepth + 1 > MAX_NESTING_DEPTH) {
			this.supported = false;
			return undefined;
		}
		return this.readRawGroupContents(start);
	}

	private splitEnvironmentRows(body: string): string[] {
		return body.split(/\\\\(?:\[[^\]\n]*\])?/);
	}

	private parseEnvironment(): string {
		const environment = this.readRawGroup();
		if (!environment) {
			return "";
		}
		const endMarker = `\\end{${environment}}`;
		const end = this.source.indexOf(endMarker, this.position);
		if (end < 0) {
			this.supported = false;
			return "";
		}
		const body = this.source.slice(this.position, end);
		this.position = end + endMarker.length;

		if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
			return this.renderNested(body).trim();
		}

		if (
			environment === "aligned" ||
			environment === "align" ||
			environment === "align*" ||
			environment === "alignedat" ||
			environment === "alignat" ||
			environment === "alignat*" ||
			environment === "gather" ||
			environment === "gathered" ||
			environment === "multline" ||
			environment === "multline*" ||
			environment === "split"
		) {
			const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
			const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.splitEnvironmentRows(alignedBody)
				.map((row) => {
					const cells = row.split("&");
					const source = alignedAt
						? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
								cells.slice(index * 2, index * 2 + 2).join(""),
							).join(" ")
						: cells.join("");
					return this.renderNested(source).trim();
				})
				.filter(Boolean)
				.join("\n");
		}

		if (environment === "cases" || environment === "cases*") {
			const rows = this.splitEnvironmentRows(body)
				.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
				.filter((row) => row.some(Boolean));
			return rows
				.map((row, index) => {
					const value = (row[0] ?? "").replace(/,\s*$/, "");
					const condition = row[1] ?? "";
					const delimiter = index === 0 ? "⎧" : index === rows.length - 1 ? "⎩" : "⎨";
					const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
					return `${delimiter} ${value}${condition ? `${conditionPrefix}${condition}` : ""}`;
				})
				.join("\n");
		}

		if (
			["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(environment)
		) {
			const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.renderMatrix(environment, matrixBody);
		}

		this.supported = false;
		return body;
	}

	private renderMatrix(environment: string, body: string): string {
		const sourceRows = this.splitEnvironmentRows(body).map((row) => row.split("&"));
		const sourceColumnCount = Math.max(0, ...sourceRows.map((row) => row.length));
		if (sourceRows.length > MAX_RENDERED_ROWS || sourceRows.length * sourceColumnCount > MAX_LAYOUT_NODES) {
			this.supported = false;
			return "";
		}
		const matrix = sourceRows
			.map((row) => row.map((cell) => this.renderNested(cell, false).trim()))
			.filter((row) => row.some(Boolean));
		const columnCount = Math.max(0, ...matrix.map((row) => row.length));
		const columnWidths = Array.from({ length: columnCount }, (_, column) =>
			Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
		);
		const rows = matrix.map((row) =>
			Array.from({ length: columnCount }, (_, column) => {
				const cell = row[column] ?? "";
				return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
			}).join(" │ "),
		);
		let lines: string[];
		if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
			lines = rows;
		} else {
			const delimiters: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
				pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
				bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
				Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
				vmatrix: ["│", "│", "│", "│", "│", "│"],
				Vmatrix: ["║", "║", "║", "║", "║", "║"],
			};
			const delimiter = delimiters[environment];
			if (!delimiter) {
				this.supported = false;
				return rows.join("\n");
			}
			lines = rows.map((row, index) => {
				const left = index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
				const right = index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
				return `${left} ${row} ${right}`;
			});
		}

		if (lines.length <= 1) {
			return lines[0] ?? "";
		}
		const index = this.addLayoutNode({ type: "matrix", lines, baseline: 0 });
		return index === undefined ? "" : `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	private addLayoutNode(node: LayoutNode): number | undefined {
		if (this.layoutNodes.length >= MAX_LAYOUT_NODES) {
			this.supported = false;
			return undefined;
		}
		return this.layoutNodes.push(node) - 1;
	}

	private parseNestedSequence(endCharacter: string): string {
		if (this.state.nestingDepth >= MAX_NESTING_DEPTH) {
			this.supported = false;
			return "";
		}
		this.state.nestingDepth++;
		try {
			return this.parseSequence(endCharacter);
		} finally {
			this.state.nestingDepth--;
		}
	}

	private renderNested(source: string, stackFractions = true): string {
		if (this.state.nestingDepth >= MAX_NESTING_DEPTH) {
			this.supported = false;
			return source;
		}
		this.state.nestingDepth++;
		let rendered: string | undefined;
		try {
			rendered = new LatexParser(source, this.layoutNodes, this.display && stackFractions, this.state).render();
		} finally {
			this.state.nestingDepth--;
		}
		if (rendered === undefined) {
			this.supported = false;
			return source;
		}
		return rendered;
	}
}

export interface RenderLatexOptions {
	/** Stack fractions and operator limits vertically for display math (default: false). */
	display?: boolean;
}

/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * Returns undefined when the expression contains unsupported or malformed syntax.
 */
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
	if (source.length > MAX_SOURCE_LENGTH || RESERVED_MARKER_PATTERN.test(source)) {
		return undefined;
	}

	try {
		const layoutNodes: LayoutNode[] = [];
		const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
		if (rendered === undefined) {
			return undefined;
		}

		let result: string;
		if (layoutNodes.length === 0) {
			result = rendered.replaceAll(PROTECTED_SPACE, " ");
		} else {
			const lines = renderLayout(rendered, layoutNodes).lines;
			const indentation = Math.min(
				...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
			);
			result = lines
				.map((line) => line.slice(indentation).trimEnd())
				.join("\n")
				.trimEnd()
				.replaceAll(PROTECTED_SPACE, " ");
		}

		const resultLines = result.split("\n");
		if (
			resultLines.length > MAX_RENDERED_ROWS ||
			resultLines.some((line) => visibleWidth(line) > MAX_RENDERED_LINE_WIDTH)
		) {
			return undefined;
		}
		return result;
	} catch {
		return undefined;
	}
}

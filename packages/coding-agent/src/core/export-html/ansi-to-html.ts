/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 */

// Standard ANSI color palette (0-15)
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * Convert 256-color index to hex.
 */
function color256ToHex(index: number): string {
	// Standard colors (0-15)
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

interface ExtendedColorResult {
	color: string;
	consumedParams: number;
}

function resetStyle(style: TextStyle): void {
	style.fg = null;
	style.bg = null;
	style.bold = false;
	style.dim = false;
	style.italic = false;
	style.underline = false;
}

function applyTextStyleCode(code: number, style: TextStyle): boolean {
	switch (code) {
		case 0:
			resetStyle(style);
			return true;
		case 1:
			style.bold = true;
			return true;
		case 2:
			style.dim = true;
			return true;
		case 3:
			style.italic = true;
			return true;
		case 4:
			style.underline = true;
			return true;
		case 22:
			style.bold = false;
			style.dim = false;
			return true;
		case 23:
			style.italic = false;
			return true;
		case 24:
			style.underline = false;
			return true;
		default:
			return false;
	}
}

type ColorStyleProperty = "fg" | "bg";

function readExtendedColor(params: number[], codeIndex: number): ExtendedColorResult | undefined {
	if (params[codeIndex + 1] === 5 && params.length > codeIndex + 2) {
		return { color: color256ToHex(params[codeIndex + 2]), consumedParams: 2 };
	}
	if (params[codeIndex + 1] === 2 && params.length > codeIndex + 4) {
		const [r, g, b] = params.slice(codeIndex + 2, codeIndex + 5);
		return { color: `rgb(${r},${g},${b})`, consumedParams: 4 };
	}
	return undefined;
}

function applyExtendedColorCode(
	params: number[],
	codeIndex: number,
	style: TextStyle,
	property: ColorStyleProperty,
): number {
	const extendedColor = readExtendedColor(params, codeIndex);
	if (!extendedColor) return 0;
	style[property] = extendedColor.color;
	return extendedColor.consumedParams;
}

function applyColorCode(params: number[], codeIndex: number, style: TextStyle): number {
	const code = params[codeIndex];
	if (code >= 30 && code <= 37) {
		style.fg = ANSI_COLORS[code - 30];
	} else if (code === 39) {
		style.fg = null;
	} else if (code >= 40 && code <= 47) {
		style.bg = ANSI_COLORS[code - 40];
	} else if (code === 49) {
		style.bg = null;
	} else if (code >= 90 && code <= 97) {
		style.fg = ANSI_COLORS[code - 90 + 8];
	} else if (code >= 100 && code <= 107) {
		style.bg = ANSI_COLORS[code - 100 + 8];
	} else if (code === 38) {
		return applyExtendedColorCode(params, codeIndex, style, "fg");
	} else if (code === 48) {
		return applyExtendedColorCode(params, codeIndex, style, "bg");
	}
	return 0;
}

/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let codeIndex = 0;
	while (codeIndex < params.length) {
		const code = params[codeIndex];
		const consumedParams = applyTextStyleCode(code, style) ? 0 : applyColorCode(params, codeIndex, style);
		codeIndex += consumedParams + 1;
	}
}

// Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// Reset regex state
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// Add text before this escape sequence
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// Parse SGR parameters
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// Close existing span if we have one
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// Apply the codes
		applySgrCode(params, style);

		// Open new span if we have any styling
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// Add remaining text
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// Close any open span
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}

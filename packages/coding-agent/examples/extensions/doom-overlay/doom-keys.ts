/**
 * DOOM key codes (from doomkeys.h)
 */
export const DoomKeys = {
	KEY_RIGHTARROW: 0xae,
	KEY_LEFTARROW: 0xac,
	KEY_UPARROW: 0xad,
	KEY_DOWNARROW: 0xaf,
	KEY_STRAFE_L: 0xa0,
	KEY_STRAFE_R: 0xa1,
	KEY_USE: 0xa2,
	KEY_FIRE: 0xa3,
	KEY_ESCAPE: 27,
	KEY_ENTER: 13,
	KEY_TAB: 9,
	KEY_F1: 0x80 + 0x3b,
	KEY_F2: 0x80 + 0x3c,
	KEY_F3: 0x80 + 0x3d,
	KEY_F4: 0x80 + 0x3e,
	KEY_F5: 0x80 + 0x3f,
	KEY_F6: 0x80 + 0x40,
	KEY_F7: 0x80 + 0x41,
	KEY_F8: 0x80 + 0x42,
	KEY_F9: 0x80 + 0x43,
	KEY_F10: 0x80 + 0x44,
	KEY_F11: 0x80 + 0x57,
	KEY_F12: 0x80 + 0x58,
	KEY_BACKSPACE: 127,
	KEY_PAUSE: 0xff,
	KEY_EQUALS: 0x3d,
	KEY_MINUS: 0x2d,
	KEY_RSHIFT: 0x80 + 0x36,
	KEY_RCTRL: 0x80 + 0x1d,
	KEY_RALT: 0x80 + 0x38,
} as const;

import { Key, type KeyId, matchesKey, parseKey } from "@fleetagent/pi-tui";

interface DoomKeyBinding {
	rawInputs: readonly string[];
	keyInputs: readonly KeyId[];
	doomKeys: readonly number[];
}

const CONTROL_KEY_BINDINGS: readonly DoomKeyBinding[] = [
	{ rawInputs: [], keyInputs: [Key.up], doomKeys: [DoomKeys.KEY_UPARROW] },
	{ rawInputs: [], keyInputs: [Key.down], doomKeys: [DoomKeys.KEY_DOWNARROW] },
	{ rawInputs: [], keyInputs: [Key.right], doomKeys: [DoomKeys.KEY_RIGHTARROW] },
	{ rawInputs: [], keyInputs: [Key.left], doomKeys: [DoomKeys.KEY_LEFTARROW] },
	{ rawInputs: ["w"], keyInputs: ["w"], doomKeys: [DoomKeys.KEY_UPARROW] },
	{ rawInputs: ["W"], keyInputs: [Key.shift("w")], doomKeys: [DoomKeys.KEY_UPARROW, DoomKeys.KEY_RSHIFT] },
	{ rawInputs: ["s"], keyInputs: ["s"], doomKeys: [DoomKeys.KEY_DOWNARROW] },
	{ rawInputs: ["S"], keyInputs: [Key.shift("s")], doomKeys: [DoomKeys.KEY_DOWNARROW, DoomKeys.KEY_RSHIFT] },
	{ rawInputs: ["a"], keyInputs: ["a"], doomKeys: [DoomKeys.KEY_STRAFE_L] },
	{ rawInputs: ["A"], keyInputs: [Key.shift("a")], doomKeys: [DoomKeys.KEY_STRAFE_L, DoomKeys.KEY_RSHIFT] },
	{ rawInputs: ["d"], keyInputs: ["d"], doomKeys: [DoomKeys.KEY_STRAFE_R] },
	{ rawInputs: ["D"], keyInputs: [Key.shift("d")], doomKeys: [DoomKeys.KEY_STRAFE_R, DoomKeys.KEY_RSHIFT] },
	{ rawInputs: ["f", "F"], keyInputs: ["f", Key.shift("f")], doomKeys: [DoomKeys.KEY_FIRE] },
	{ rawInputs: [" "], keyInputs: [Key.space], doomKeys: [DoomKeys.KEY_USE] },
	{ rawInputs: [], keyInputs: [Key.enter], doomKeys: [DoomKeys.KEY_ENTER] },
	{ rawInputs: [], keyInputs: [Key.escape], doomKeys: [DoomKeys.KEY_ESCAPE] },
	{ rawInputs: [], keyInputs: [Key.tab], doomKeys: [DoomKeys.KEY_TAB] },
	{ rawInputs: [], keyInputs: [Key.backspace], doomKeys: [DoomKeys.KEY_BACKSPACE] },
];

const PROMPT_KEY_BINDINGS: readonly DoomKeyBinding[] = [
	{ rawInputs: ["y", "Y"], keyInputs: ["y", Key.shift("y")], doomKeys: ["y".charCodeAt(0)] },
	{ rawInputs: ["n", "N"], keyInputs: ["n", Key.shift("n")], doomKeys: ["n".charCodeAt(0)] },
];

function findMatchingDoomBinding(data: string, bindings: readonly DoomKeyBinding[]): number[] | undefined {
	for (const binding of bindings) {
		if (binding.rawInputs.includes(data)) return [...binding.doomKeys];
		if (binding.keyInputs.some((key) => matchesKey(data, key))) return [...binding.doomKeys];
	}
	return undefined;
}

function isLegacyFireInput(data: string): boolean {
	const parsed = parseKey(data);
	if (parsed?.startsWith("ctrl+") && parsed !== "ctrl+c") return true;
	return data.length === 1 && data.charCodeAt(0) < 32 && data !== "\x03";
}

function mapPrintableKeyToDoom(data: string): number[] {
	if (data >= "0" && data <= "9") return [data.charCodeAt(0)];
	if (data === "+" || data === "=") return [DoomKeys.KEY_EQUALS];
	if (data === "-") return [DoomKeys.KEY_MINUS];
	const promptKey = findMatchingDoomBinding(data, PROMPT_KEY_BINDINGS);
	if (promptKey) return promptKey;
	if (data.length === 1 && data.charCodeAt(0) >= 32) return [data.toLowerCase().charCodeAt(0)];
	return [];
}

/**
 * Map terminal key input to DOOM key codes
 * Supports both raw terminal input and Kitty protocol sequences
 */
export function mapKeyToDoom(data: string): number[] {
	const controlKey = findMatchingDoomBinding(data, CONTROL_KEY_BINDINGS);
	if (controlKey) return controlKey;
	if (isLegacyFireInput(data)) return [DoomKeys.KEY_FIRE];
	return mapPrintableKeyToDoom(data);
}

const SGR_SEQUENCE = /^\x1b\[[0-9:;]*m/;

/** Remove characters that can terminate or introduce terminal control strings. */
export function sanitizeTerminalControlPayload(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Preserve SGR color/style sequences while removing all other control characters. */
export function sanitizeHyperlinkText(value: string): string {
	let result = "";
	let offset = 0;
	while (offset < value.length) {
		if (value.charCodeAt(offset) === 0x1b) {
			const sgr = value.slice(offset).match(SGR_SEQUENCE)?.[0];
			if (sgr) {
				result += sgr;
				offset += sgr.length;
				continue;
			}
		}
		const code = value.charCodeAt(offset);
		if (code > 0x1f && (code < 0x7f || code > 0x9f)) result += value[offset];
		offset++;
	}
	return result;
}

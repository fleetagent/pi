import { extname } from "node:path";

export const LSP_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
	".cjs": "javascript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".mts": "typescript",
	".ts": "typescript",
	".tsx": "typescriptreact",
};

export function getLspLanguageId(filePath: string): string | undefined {
	return LSP_LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()];
}

import type {
	MarkdownMessageType,
	MarkdownTransformContext,
	MarkdownTransformer,
} from "../../../core/extensions/types.ts";

export function createMarkdownTransform(
	messageType: MarkdownMessageType,
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}

export function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed: unknown = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Preserve the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}

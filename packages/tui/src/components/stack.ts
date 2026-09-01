import {
	LAYOUT_NODE,
	type LayoutViewport,
	type StackAlignment,
	type StackLayoutEntry,
	type StackLayoutNode,
	type StackLayoutType,
} from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

type StackDistributionMode = "grow" | "shrink";

interface StackDistributionCandidate {
	index: number;
	weight: number;
	capacity: number;
}

export interface StackEntryOptions {
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: StackAlignment;
}

function isStackEntry(child: StackChild): child is StackEntry {
	return !("render" in child);
}

function normalizeSize(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: StackAlignment;
	protected abstract readonly layoutType: StackLayoutType;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = normalizeSize(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if (isStackEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);
		this.entries.push({
			component,
			...(options.basis === undefined ? {} : { basis: options.basis }),
			...(options.grow === undefined ? {} : { grow: normalizeSize(options.grow, 0) }),
			...(options.shrink === undefined ? {} : { shrink: normalizeSize(options.shrink, 1) }),
			...(options.minSize === undefined ? {} : { minSize: normalizeSize(options.minSize, 0) }),
			...(options.maxSize === undefined ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) }),
			...(options.visible === undefined ? {} : { visible: options.visible }),
		});
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.entries.splice(index, 1);
	}

	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}

	[LAYOUT_NODE](): StackLayoutNode {
		return {
			type: this.layoutType,
			entries: this.entries,
			gap: this.gap,
			align: this.align,
		};
	}
}

export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

function clampSize(size: number, entry: StackLayoutEntry): number {
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

function getDistributionWeight(entry: StackLayoutEntry, size: number, mode: StackDistributionMode): number {
	return mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, size);
}

function getDistributionCapacity(entry: StackLayoutEntry, size: number, mode: StackDistributionMode): number {
	return mode === "grow" ? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - size : size - (entry.minSize ?? 0);
}

function collectDistributionCandidates(
	sizes: number[],
	entries: readonly StackLayoutEntry[],
	mode: StackDistributionMode,
): StackDistributionCandidate[] {
	const candidates: StackDistributionCandidate[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		const size = sizes[index]!;
		const weight = getDistributionWeight(entry, size, mode);
		const capacity = getDistributionCapacity(entry, size, mode);
		if (weight > 0 && capacity > 0) candidates.push({ index, weight, capacity });
	}
	return candidates;
}

function distributeStackSizeRound(
	sizes: number[],
	candidates: StackDistributionCandidate[],
	amount: number,
	mode: StackDistributionMode,
): number {
	const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
	let remaining = amount;
	let distributed = 0;
	for (const candidate of candidates) {
		if (remaining <= 0) break;
		const proposed = Math.max(1, Math.floor((remaining * candidate.weight) / totalWeight));
		const delta = Math.min(remaining, proposed, candidate.capacity);
		if (delta <= 0) continue;
		sizes[candidate.index] = sizes[candidate.index]! + (mode === "grow" ? delta : -delta);
		remaining -= delta;
		distributed += delta;
	}
	return distributed;
}

function distribute(
	sizes: number[],
	entries: readonly StackLayoutEntry[],
	amount: number,
	mode: StackDistributionMode,
): void {
	let remaining = amount;
	while (remaining > 0) {
		const candidates = collectDistributionCandidates(sizes, entries, mode);
		if (candidates.length === 0) return;
		const distributed = distributeStackSizeRound(sizes, candidates, remaining, mode);
		if (distributed === 0) return;
		remaining -= distributed;
	}
}

export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = entries.map((entry, index) =>
		clampSize(
			entry.basis === undefined || entry.basis === "auto" ? (intrinsicSizes[index] ?? 0) : entry.basis,
			entry,
		),
	);
	if (availableSize === undefined) return sizes;

	const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total < contentSize) distribute(sizes, entries, contentSize - total, "grow");
	else if (total > contentSize) distribute(sizes, entries, total - contentSize, "shrink");
	return sizes;
}

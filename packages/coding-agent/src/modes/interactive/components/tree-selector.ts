import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { AssistantMessage } from "@fleetagent/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@fleetagent/pi-tui";
import type { SessionTreeNode } from "../../../core/session/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

interface TreeTraversalItem {
	node: SessionTreeNode;
	indent: number;
	justBranched: boolean;
	showConnector: boolean;
	isLast: boolean;
	gutters: GutterInfo[];
	isVirtualRootChild: boolean;
}

interface VisibleTreeStructure {
	parentMap: Map<string, string | null>;
	childrenMap: Map<string | null, string[]>;
	nodesById: Map<string, FlatNode>;
	rootIds: string[];
}

interface VisibleChildLayout {
	indent: number;
	gutters: GutterInfo[];
	branched: boolean;
}
// pi-ignore noNearIdenticalDataStructures: Viewport slice indices and terminal selection cell columns evolve independently.
interface VisibleNodeRange {
	start: number;
	end: number;
}

type BranchSegmentTraversalDirection = "up" | "down";

/** Filter mode for tree display */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

const FILTER_MODES: readonly FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

function hasTreeSearchControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * Tree list component with selection and ASCII art visualization
 */
/** Tool call info for lookup */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

type TreeFileMutationToolName = "write" | "edit";
type TreeSearchToolName = "grep" | "find";

function shortenTreeToolPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatTreeReadToolCall(args: Record<string, unknown>): string {
	const path = shortenTreeToolPath(String(args.path || args.file_path || ""));
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let display = path;
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 1;
		const end = limit !== undefined ? start + limit - 1 : "";
		display += `:${start}${end ? `-${end}` : ""}`;
	}
	return `[read: ${display}]`;
}

function formatTreeFileMutationToolCall(name: TreeFileMutationToolName, args: Record<string, unknown>): string {
	return `[${name}: ${shortenTreeToolPath(String(args.path || args.file_path || ""))}]`;
}

function formatTreeBashToolCall(args: Record<string, unknown>): string {
	const rawCommand = String(args.command || "");
	const command = rawCommand
		.replace(/[\n\t]/g, " ")
		.trim()
		.slice(0, 50);
	return `[bash: ${command}${rawCommand.length > 50 ? "..." : ""}]`;
}

function formatTreeSearchToolCall(name: TreeSearchToolName, args: Record<string, unknown>): string {
	const pattern = String(args.pattern || "");
	const path = shortenTreeToolPath(String(args.path || "."));
	return name === "grep" ? `[grep: /${pattern}/ in ${path}]` : `[find: ${pattern} in ${path}]`;
}

function formatCustomTreeToolCall(name: string, args: Record<string, unknown>): string {
	const argsString = JSON.stringify(args).slice(0, 40);
	return `[${name}: ${argsString}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
}

class TreeList implements Component {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private currentLeafId: string | null;
	private maxVisibleLines: number;
	private filterMode: FilterMode = "default";
	private searchQuery = "";
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	private multipleRoots = false;
	private showLabelTimestamps = false;
	private activePathIds: Set<string> = new Set();
	private visibleParentMap: Map<string, string | null> = new Map();
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	private lastSelectedId: string | null = null;
	private foldedNodes: Set<string> = new Set();

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onCopy?: (text: string | undefined) => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		this.currentLeafId = currentLeafId;
		this.maxVisibleLines = maxVisibleLines;
		this.filterMode = initialFilterMode ?? "default";
		this.multipleRoots = tree.length > 1;
		this.flatNodes = this.flattenTree(tree);
		this.buildActivePath();
		this.applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	private findNearestVisibleIndex(entryId: string | null): number {
		if (this.filteredNodes.length === 0) return 0;

		// Build a map for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Build a map of visible entry IDs to their indices in filteredNodes
		const visibleIdToIndex = new Map<string, number>(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// Walk from entryId up to root, looking for a visible entry
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// Fallback: last visible entry
		return this.filteredNodes.length - 1;
	}

	/** Build the set of entry IDs on the path from root to current leaf */
	private buildActivePath(): void {
		this.activePathIds.clear();
		if (!this.currentLeafId) return;

		// Build a map of id -> entry for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Walk from leaf to root
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	private findActiveSubtrees(roots: SessionTreeNode[]): Map<SessionTreeNode, boolean> {
		const allNodes: SessionTreeNode[] = [];
		const preOrderStack = [...roots];
		while (preOrderStack.length > 0) {
			const node = preOrderStack.pop()!;
			allNodes.push(node);
			for (let i = node.children.length - 1; i >= 0; i--) preOrderStack.push(node.children[i]);
		}

		const containsActive = new Map<SessionTreeNode, boolean>();
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let hasActiveEntry = this.currentLeafId !== null && node.entry.id === this.currentLeafId;
			for (const child of node.children) {
				if (containsActive.get(child)) hasActiveEntry = true;
			}
			containsActive.set(node, hasActiveEntry);
		}
		return containsActive;
	}

	private createTreeTraversalStack(
		roots: SessionTreeNode[],
		containsActive: Map<SessionTreeNode, boolean>,
	): TreeTraversalItem[] {
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		const stack: TreeTraversalItem[] = [];
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			stack.push({
				node: orderedRoots[i],
				indent: this.multipleRoots ? 1 : 0,
				justBranched: this.multipleRoots,
				showConnector: this.multipleRoots,
				isLast: i === orderedRoots.length - 1,
				gutters: [],
				isVirtualRootChild: this.multipleRoots,
			});
		}
		return stack;
	}

	private recordAssistantToolCalls(node: SessionTreeNode): void {
		const entry = node.entry;
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		const content = (entry.message as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "toolCall") continue;
			const toolCall = block as { id: string; name: string; arguments: Record<string, unknown> };
			this.toolCallMap.set(toolCall.id, { name: toolCall.name, arguments: toolCall.arguments });
		}
	}

	private prioritizeActiveChildren(
		children: SessionTreeNode[],
		containsActive: Map<SessionTreeNode, boolean>,
	): SessionTreeNode[] {
		const prioritized: SessionTreeNode[] = [];
		const rest: SessionTreeNode[] = [];
		for (const child of children) {
			if (containsActive.get(child)) prioritized.push(child);
			else rest.push(child);
		}
		return [...prioritized, ...rest];
	}

	private getTraversalChildIndent(item: TreeTraversalItem, multipleChildren: boolean): number {
		if (multipleChildren || (item.justBranched && item.indent > 0)) return item.indent + 1;
		return item.indent;
	}

	private getTraversalChildGutters(item: TreeTraversalItem): GutterInfo[] {
		if (!item.showConnector || item.isVirtualRootChild) return item.gutters;
		const currentDisplayIndent = this.multipleRoots ? Math.max(0, item.indent - 1) : item.indent;
		return [...item.gutters, { position: Math.max(0, currentDisplayIndent - 1), show: !item.isLast }];
	}

	private pushTraversalChildren(
		stack: TreeTraversalItem[],
		item: TreeTraversalItem,
		containsActive: Map<SessionTreeNode, boolean>,
	): void {
		const orderedChildren = this.prioritizeActiveChildren(item.node.children, containsActive);
		const multipleChildren = orderedChildren.length > 1;
		const childIndent = this.getTraversalChildIndent(item, multipleChildren);
		const childGutters = this.getTraversalChildGutters(item);
		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			stack.push({
				node: orderedChildren[i],
				indent: childIndent,
				justBranched: multipleChildren,
				showConnector: multipleChildren,
				isLast: i === orderedChildren.length - 1,
				gutters: childGutters,
				isVirtualRootChild: false,
			});
		}
	}

	private flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		this.toolCallMap.clear();
		const result: FlatNode[] = [];
		const containsActive = this.findActiveSubtrees(roots);
		const stack = this.createTreeTraversalStack(roots, containsActive);

		while (stack.length > 0) {
			const item = stack.pop()!;
			this.recordAssistantToolCalls(item.node);
			result.push({
				node: item.node,
				indent: item.indent,
				showConnector: item.showConnector,
				isLast: item.isLast,
				gutters: item.gutters,
				isVirtualRootChild: item.isVirtualRootChild,
			});
			this.pushTraversalChildren(stack, item, containsActive);
		}
		return result;
	}

	private shouldDisplayAssistantNode(flatNode: FlatNode): boolean {
		const entry = flatNode.node.entry;
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.id === this.currentLeafId) {
			return true;
		}
		const message = entry.message as { stopReason?: string; content?: unknown };
		const hasText = this.hasTextContent(message.content);
		const isErrorOrAborted =
			message.stopReason !== undefined && message.stopReason !== "stop" && message.stopReason !== "toolUse";
		return hasText || isErrorOrAborted;
	}

	private passesNodeFilterMode(flatNode: FlatNode): boolean {
		const entry = flatNode.node.entry;
		const isSettingsEntry =
			entry.type === "label" ||
			entry.type === "custom" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "session_info";
		switch (this.filterMode) {
			case "user-only":
				return entry.type === "message" && entry.message.role === "user";
			case "no-tools":
				return !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
			case "labeled-only":
				return flatNode.node.label !== undefined;
			case "all":
				return true;
			default:
				return !isSettingsEntry;
		}
	}

	private matchesNodeSearch(flatNode: FlatNode, searchTokens: string[]): boolean {
		if (searchTokens.length === 0) return true;
		const nodeText: string = this.getSearchableText(flatNode.node).toLowerCase();
		return searchTokens.every((token) => nodeText.includes(token));
	}

	private shouldIncludeFilteredNode(flatNode: FlatNode, searchTokens: string[]): boolean {
		if (!this.shouldDisplayAssistantNode(flatNode)) return false;
		if (!this.passesNodeFilterMode(flatNode)) return false;
		return this.matchesNodeSearch(flatNode, searchTokens);
	}
	private applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.filteredNodes = this.flatNodes.filter((flatNode) => this.shouldIncludeFilteredNode(flatNode, searchTokens));

		// Filter out descendants of folded nodes.
		if (this.foldedNodes.size > 0) {
			const skipSet = new Set<string>();
			for (const flatNode of this.flatNodes) {
				const { id, parentId } = flatNode.node.entry;
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					skipSet.add(id);
				}
			}
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// Recalculate visual structure (indent, connectors, gutters) based on visible tree
		this.recalculateVisualStructure();

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.lastSelectedId) {
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// Clamp index if out of bounds
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	private findNearestVisibleAncestor(
		nodeId: string,
		visibleIds: ReadonlySet<string>,
		nodesById: ReadonlyMap<string, FlatNode>,
	): string | null {
		let currentId = nodesById.get(nodeId)?.node.entry.parentId ?? null;
		while (currentId !== null) {
			if (visibleIds.has(currentId)) return currentId;
			currentId = nodesById.get(currentId)?.node.entry.parentId ?? null;
		}
		return null;
	}

	private buildVisibleTreeStructure(): VisibleTreeStructure {
		const visibleIds = new Set(this.filteredNodes.map((flatNode) => flatNode.node.entry.id));
		const allNodesById = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) allNodesById.set(flatNode.node.entry.id, flatNode);
		const parentMap = new Map<string, string | null>();
		const childrenMap = new Map<string | null, string[]>([[null, []]]);
		const nodesById = new Map<string, FlatNode>();
		for (const flatNode of this.filteredNodes) {
			const nodeId = flatNode.node.entry.id;
			const ancestorId = this.findNearestVisibleAncestor(nodeId, visibleIds, allNodesById);
			parentMap.set(nodeId, ancestorId);
			nodesById.set(nodeId, flatNode);
			let children = childrenMap.get(ancestorId);
			if (!children) {
				children = [];
				childrenMap.set(ancestorId, children);
			}
			children.push(nodeId);
		}
		return { parentMap, childrenMap, nodesById, rootIds: childrenMap.get(null) ?? [] };
	}

	private resolveVisibleChildLayout(item: TreeTraversalItem, multipleChildren: boolean): VisibleChildLayout {
		let indent = item.indent;
		if (multipleChildren || (item.justBranched && item.indent > 0)) indent++;
		const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
		const currentDisplayIndent = this.multipleRoots ? Math.max(0, item.indent - 1) : item.indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const gutters = connectorDisplayed
			? [...item.gutters, { position: connectorPosition, show: !item.isLast }]
			: item.gutters;
		return { indent, gutters, branched: multipleChildren };
	}

	private layoutVisibleTree(structure: VisibleTreeStructure): void {
		const stack: TreeTraversalItem[] = [];
		for (let index = structure.rootIds.length - 1; index >= 0; index--) {
			const flatNode = structure.nodesById.get(structure.rootIds[index]);
			if (!flatNode) continue;
			stack.push({
				node: flatNode.node,
				indent: this.multipleRoots ? 1 : 0,
				justBranched: this.multipleRoots,
				showConnector: this.multipleRoots,
				isLast: index === structure.rootIds.length - 1,
				gutters: [],
				isVirtualRootChild: this.multipleRoots,
			});
		}
		while (stack.length > 0) {
			const item = stack.pop()!;
			const nodeId = item.node.entry.id;
			const flatNode = structure.nodesById.get(nodeId);
			if (!flatNode) continue;
			flatNode.indent = item.indent;
			flatNode.showConnector = item.showConnector;
			flatNode.isLast = item.isLast;
			flatNode.gutters = item.gutters;
			flatNode.isVirtualRootChild = item.isVirtualRootChild;
			const children = structure.childrenMap.get(nodeId) ?? [];
			const childLayout = this.resolveVisibleChildLayout(item, children.length > 1);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = structure.nodesById.get(children[index]);
				if (!child) continue;
				stack.push({
					node: child.node,
					indent: childLayout.indent,
					justBranched: childLayout.branched,
					showConnector: childLayout.branched,
					isLast: index === children.length - 1,
					gutters: childLayout.gutters,
					isVirtualRootChild: false,
				});
			}
		}
	}

	/**
	 * Recompute indentation/connectors for the filtered view.
	 * Filtering can hide intermediate entries, so descendants attach to the nearest visible ancestor.
	 */
	private recalculateVisualStructure(): void {
		if (this.filteredNodes.length === 0) return;
		const structure = this.buildVisibleTreeStructure();
		this.multipleRoots = structure.rootIds.length > 1;
		this.layoutVisibleTree(structure);
		this.visibleParentMap = structure.parentMap;
		this.visibleChildrenMap = structure.childrenMap;
	}

	/** Get searchable text content from a node */
	private getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "session_info":
				parts.push("title");
				if (entry.name) parts.push(entry.name);
				break;
			case "model_change":
				parts.push("model", entry.modelId);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	copySelected(): void {
		const node = this.getSelectedNode();
		this.onCopy?.(node ? this.getEntryCopyText(node) : undefined);
	}

	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		for (const flatNode of this.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	private getStatusLabels(): string {
		let labels = "";
		switch (this.filterMode) {
			case "no-tools":
				labels += " [no-tools]";
				break;
			case "user-only":
				labels += " [user]";
				break;
			case "labeled-only":
				labels += " [labeled]";
				break;
			case "all":
				labels += " [all]";
				break;
		}
		if (this.showLabelTimestamps) {
			labels += " [+label time]";
		}
		return labels;
	}

	private getVisibleNodeRange(): VisibleNodeRange {
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		return { start, end: Math.min(start + this.maxVisibleLines, this.filteredNodes.length) };
	}

	private renderPrefixCharacter(
		flatNode: FlatNode,
		entryId: string,
		level: number,
		position: number,
		connectorPosition: number,
		isFolded: boolean,
	): string {
		const gutter = flatNode.gutters.find((candidate) => candidate.position === level);
		if (gutter) return position === 0 && gutter.show ? "│" : " ";
		if (level !== connectorPosition) return " ";
		if (position === 0) return flatNode.isLast ? "└" : "├";
		if (position !== 1) return " ";
		if (isFolded) return "⊞";
		return this.isFoldable(entryId) ? "⊟" : "─";
	}

	private renderNodePrefix(flatNode: FlatNode): string {
		const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
		const showsConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
		const connectorPosition = showsConnector ? displayIndent - 1 : -1;
		const isFolded = this.foldedNodes.has(flatNode.node.entry.id);
		const characters: string[] = [];
		for (let index = 0; index < displayIndent * 3; index++) {
			characters.push(
				this.renderPrefixCharacter(
					flatNode,
					flatNode.node.entry.id,
					Math.floor(index / 3),
					index % 3,
					connectorPosition,
					isFolded,
				),
			);
		}
		const foldMarker = isFolded && !showsConnector ? theme.fg("accent", "⊞ ") : "";
		return theme.fg("dim", characters.join("")) + foldMarker;
	}

	private renderNodeLine(flatNode: FlatNode, index: number, width: number): string {
		const entry = flatNode.node.entry;
		const isSelected = index === this.selectedIndex;
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const pathMarker = this.activePathIds.has(entry.id) ? theme.fg("accent", "• ") : "";
		const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
		const labelTimestamp =
			this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
				? theme.fg("muted", `${this.formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
				: "";
		const content = this.getEntryDisplayText(flatNode.node, isSelected);
		const line = cursor + this.renderNodePrefix(flatNode) + pathMarker + label + labelTimestamp + content;
		return truncateToWidth(isSelected ? theme.bg("selectedBg", line) : line, width);
	}

	render(width: number): string[] {
		if (this.filteredNodes.length === 0) {
			return [
				truncateToWidth(theme.fg("muted", "  No entries found"), width),
				truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width),
			];
		}
		const lines: string[] = [];
		const range = this.getVisibleNodeRange();
		for (let index = range.start; index < range.end; index++) {
			lines.push(this.renderNodeLine(this.filteredNodes[index], index, width));
		}
		lines.push(
			truncateToWidth(
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				width,
			),
		);
		return lines;
	}
	private normalizeDisplayText(value: string): string {
		return value.replace(/[\n\t]/g, " ").trim();
	}

	private getAssistantDisplayText(message: AssistantMessage): string {
		const textContent = this.normalizeDisplayText(this.extractContent(message.content));
		if (textContent) return theme.fg("success", "assistant: ") + textContent;
		if (message.stopReason === "aborted") {
			return theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
		}
		if (message.errorMessage) {
			const errorMessage = this.normalizeDisplayText(message.errorMessage).slice(0, 80);
			return theme.fg("success", "assistant: ") + theme.fg("error", errorMessage);
		}
		return theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
	}

	private getMessageDisplayText(message: AgentMessage): string {
		switch (message.role) {
			case "user":
				return theme.fg("accent", "user: ") + this.normalizeDisplayText(this.extractContent(message.content));
			case "assistant":
				return this.getAssistantDisplayText(message);
			case "toolResult": {
				const toolCall = this.toolCallMap.get(message.toolCallId);
				return toolCall
					? theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments))
					: theme.fg("muted", `[${message.toolName ?? "tool"}]`);
			}
			case "bashExecution":
				return theme.fg("dim", `[bash]: ${this.normalizeDisplayText(message.command ?? "")}`);
			default:
				return theme.fg("dim", `[${message.role}]`);
		}
	}

	private getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		switch (entry.type) {
			case "message":
				result = this.getMessageDisplayText(entry.message);
				break;
			case "custom_message":
				result =
					theme.fg("customMessageLabel", `[${entry.customType}]: `) +
					this.normalizeDisplayText(this.extractFullContent(entry.content));
				break;
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + this.normalizeDisplayText(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.modelId}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			case "session_info":
				result = entry.name
					? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
					: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
	}

	private formatLabelTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		const time = `${hours}:${minutes}`;

		if (
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate()
		) {
			return time;
		}

		const month = date.getMonth() + 1;
		const day = date.getDate();
		if (date.getFullYear() === now.getFullYear()) {
			return `${month}/${day} ${time}`;
		}

		const year = date.getFullYear().toString().slice(-2);
		return `${year}/${month}/${day} ${time}`;
	}

	private extractContent(content: unknown): string {
		return this.extractFullContent(content).slice(0, 200);
	}

	private extractFullContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
				result += (block as { text: string }).text;
			}
		}
		return result;
	}

	private getEntryCopyText(node: SessionTreeNode): string | undefined {
		const entry = node.entry;
		let text: string | undefined;

		switch (entry.type) {
			case "message":
				if (entry.message.role === "bashExecution") {
					text = entry.message.command;
				} else if ("content" in entry.message) {
					text = this.extractFullContent(entry.message.content);
					if (!text && entry.message.role === "assistant") {
						text = entry.message.errorMessage;
					}
				}
				break;
			case "custom_message":
				text = this.extractFullContent(entry.content);
				break;
			case "compaction":
				text = entry.summary;
				break;
			case "branch_summary":
				text = entry.summary;
				break;
		}

		return text?.trim() ? text : undefined;
	}

	private hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return content.trim().length > 0;
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && text.trim().length > 0) return true;
				}
			}
		}
		return false;
	}

	private formatToolCall(name: string, args: Record<string, unknown>): string {
		switch (name) {
			case "read":
				return formatTreeReadToolCall(args);
			case "write":
			case "edit":
				return formatTreeFileMutationToolCall(name, args);
			case "bash":
				return formatTreeBashToolCall(args);
			case "grep":
			case "find":
				return formatTreeSearchToolCall(name, args);
			case "ls":
				return `[ls: ${shortenTreeToolPath(String(args.path || "."))}]`;
			default:
				return formatCustomTreeToolCall(name, args);
		}
	}

	private foldSelectedNodeOrMoveToPreviousBranch(): void {
		const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
			this.foldedNodes.add(currentId);
			this.applyFilter();
			return;
		}
		this.selectedIndex = this.findBranchSegmentStart("up");
	}

	private unfoldSelectedNodeOrMoveToNextBranch(): void {
		const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (currentId && this.foldedNodes.has(currentId)) {
			this.foldedNodes.delete(currentId);
			this.applyFilter();
			return;
		}
		this.selectedIndex = this.findBranchSegmentStart("down");
	}

	private handleTreeMovementInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
			return true;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
			return true;
		}
		if (kb.matches(keyData, "app.tree.foldOrUp")) {
			this.foldSelectedNodeOrMoveToPreviousBranch();
			return true;
		}
		if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			this.unfoldSelectedNodeOrMoveToNextBranch();
			return true;
		}
		if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
			return true;
		}
		if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
			return true;
		}
		return false;
	}

	private cancelSearchOrSelection(): void {
		if (!this.searchQuery) {
			this.onCancel?.();
			return;
		}
		this.searchQuery = "";
		this.foldedNodes.clear();
		this.applyFilter();
	}

	private handleTreeSelectionInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected) this.onSelect?.(selected.node.entry.id);
			return true;
		}
		if (kb.matches(keyData, "app.message.copy")) {
			this.copySelected();
			return true;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancelSearchOrSelection();
			return true;
		}
		return false;
	}

	private setFilterMode(mode: FilterMode): void {
		this.filterMode = mode;
		this.foldedNodes.clear();
		this.applyFilter();
	}

	private toggleFilterMode(mode: FilterMode): void {
		this.setFilterMode(this.filterMode === mode ? "default" : mode);
	}

	private cycleFilterMode(step: number): void {
		const currentIndex = FILTER_MODES.indexOf(this.filterMode);
		this.setFilterMode(FILTER_MODES[(currentIndex + step + FILTER_MODES.length) % FILTER_MODES.length]);
	}

	private handleTreeFilterInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tree.filter.default")) this.setFilterMode("default");
		else if (kb.matches(keyData, "app.tree.filter.noTools")) this.toggleFilterMode("no-tools");
		else if (kb.matches(keyData, "app.tree.filter.userOnly")) this.toggleFilterMode("user-only");
		else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) this.toggleFilterMode("labeled-only");
		else if (kb.matches(keyData, "app.tree.filter.all")) this.toggleFilterMode("all");
		else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) this.cycleFilterMode(-1);
		else if (kb.matches(keyData, "app.tree.filter.cycleForward")) this.cycleFilterMode(1);
		else return false;
		return true;
	}

	private appendTreeSearchInput(keyData: string): void {
		if (keyData.length === 0 || hasTreeSearchControlCharacters(keyData)) return;
		this.searchQuery += keyData;
		this.foldedNodes.clear();
		this.applyFilter();
	}

	private handleTreeEditingInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.foldedNodes.clear();
				this.applyFilter();
			}
			return;
		}
		if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected) this.onLabelEdit?.(selected.node.entry.id, selected.node.label);
			return;
		}
		if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
			return;
		}
		this.appendTreeSearchInput(keyData);
	}

	handleInput(keyData: string): void {
		if (this.handleTreeMovementInput(keyData)) return;
		if (this.handleTreeSelectionInput(keyData)) return;
		if (this.handleTreeFilterInput(keyData)) return;
		this.handleTreeEditingInput(keyData);
	}

	/**
	 * Whether a node can be folded. A node is foldable if it has visible children
	 * and is either a root (no visible parent) or a segment start (visible parent
	 * has multiple visible children).
	 */
	private isFoldable(entryId: string): boolean {
		const children = this.visibleChildrenMap.get(entryId);
		if (!children || children.length === 0) return false;
		const parentId = this.visibleParentMap.get(entryId);
		if (parentId === null || parentId === undefined) return true;
		const siblings = this.visibleChildrenMap.get(parentId);
		return siblings !== undefined && siblings.length > 1;
	}

	private findNextBranchSegmentStart(selectedId: string, indexByEntryId: ReadonlyMap<string, number>): number {
		let currentId = selectedId;
		while (true) {
			const children = this.visibleChildrenMap.get(currentId) ?? [];
			if (children.length === 0) return indexByEntryId.get(currentId)!;
			if (children.length > 1) return indexByEntryId.get(children[0])!;
			currentId = children[0];
		}
	}

	private findPreviousBranchSegmentStart(selectedId: string, indexByEntryId: ReadonlyMap<string, number>): number {
		let currentId = selectedId;
		while (true) {
			const parentId = this.visibleParentMap.get(currentId) ?? null;
			if (parentId === null) return indexByEntryId.get(currentId)!;
			const siblings = this.visibleChildrenMap.get(parentId) ?? [];
			if (siblings.length > 1) {
				const segmentStart = indexByEntryId.get(currentId)!;
				if (segmentStart < this.selectedIndex) return segmentStart;
			}
			currentId = parentId;
		}
	}

	/**
	 * Find the index of the next branch segment start in the given direction.
	 * A segment start is the first child of a branch point.
	 *
	 * "up" walks the visible parent chain; "down" walks visible children
	 * (always following the first child).
	 */
	private findBranchSegmentStart(direction: BranchSegmentTraversalDirection): number {
		const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (!selectedId) return this.selectedIndex;

		const indexByEntryId = new Map(this.filteredNodes.map((node, index) => [node.node.entry.id, index]));
		return direction === "down"
			? this.findNextBranchSegmentStart(selectedId, indexByEntryId)
			: this.findPreviousBranchSegmentStart(selectedId, indexByEntryId);
	}
}

/** Component that displays the current search query */
class SearchLine implements Component {
	private treeList: TreeList;

	constructor(treeList: TreeList) {
		this.treeList = treeList;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
	}

	handleInput(_keyData: string): void {}
}

/** Label input component shown when editing a label */
class LabelInput implements Component, Focusable {
	private input: Input;
	private entryId: string;
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	public onCancel?: () => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(entryId: string, currentLabel: string | undefined) {
		this.entryId = entryId;
		this.input = new Input();
		if (currentLabel) {
			this.input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		lines.push(
			truncateToWidth(
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				width,
			),
		);
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const value = this.input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.input.handleInput(keyData);
		}
	}
}

/**
 * Component that renders a session tree selector for navigation
 */
export class TreeSelectorComponent extends Container implements Focusable {
	private treeList: TreeList;
	private labelInput: LabelInput | null = null;
	private labelInputContainer: Container;
	private treeContainer: Container;
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
	public onCopy?: (text: string | undefined) => void;

	// Focusable implementation - propagate to labelInput when active for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// Propagate to labelInput when it's active
		if (this.labelInput) {
			this.labelInput.focused = value;
		}
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onCopy = (text) => this.onCopy?.(text);
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		const filterKeys = [
			keyText("app.tree.filter.default"),
			keyText("app.tree.filter.noTools"),
			keyText("app.tree.filter.userOnly"),
			keyText("app.tree.filter.labeledOnly"),
			keyText("app.tree.filter.all"),
		].join("/");
		const cycleKeys = `${keyText("app.tree.filter.cycleForward")}/${keyText("app.tree.filter.cycleBackward")}`;
		const branchKeys = `${keyText("app.tree.foldOrUp")}/${keyText("app.tree.unfoldOrDown")}`;
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					`  ↑/↓: move. ←/→: page. ${branchKeys}: fold/branch. ${keyText("app.message.copy")}: copy. ${keyText("app.tree.editLabel")}: label. ${filterKeys}: filters (${cycleKeys} cycle). ${keyText("app.tree.toggleLabelTimestamp")}: label time`,
				),
				0,
				0,
			),
		);
		this.addChild(new SearchLine(this.treeList));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			this.treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.hideLabelInput();
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// Propagate current focused state to the new labelInput
		this.labelInput.focused = this._focused;

		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	private hideLabelInput(): void {
		this.labelInput = null;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	handleInput(keyData: string): void {
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
		} else {
			this.treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.treeList;
	}
}

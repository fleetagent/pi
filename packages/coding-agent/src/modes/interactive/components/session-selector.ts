import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@fleetagent/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session/types.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

type SessionScope = "current" | "all";
type SessionSelectorMessageType = "info" | "error";
type SessionDeletionMethod = "trash" | "unlink";
type SessionSelectorMode = "list" | "rename";
type SessionLoadReason = "initial" | "refresh" | "toggle";

interface SessionSelectorStatusMessage {
	type: SessionSelectorMessageType;
	message: string;
}

interface SessionSelectorHintLines {
	primary: string;
	secondary: string;
}

interface DeleteSessionResult {
	ok: boolean;
	method: SessionDeletionMethod;
	error?: string;
}

interface SessionScopeLoadContext {
	scope: SessionScope;
	reason: SessionLoadReason;
	showCwd: boolean;
	sequence?: number;
}

interface SessionSelectorLayoutOptions {
	showHeader?: boolean;
}

interface SessionSelectorOptions {
	renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	showRenameHint?: boolean;
	keybindings?: KeybindingsManager;
}

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: SessionSelectorStatusMessage | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: SessionSelectorStatusMessage | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	private renderHintLines(width: number): SessionSelectorHintLines {
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			return { primary: theme.fg("error", truncateToWidth(confirmHint, width, "…")), secondary: "" };
		}
		if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			return {
				primary: theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…")),
				secondary: "",
			};
		}

		const pathState = this.showPath ? "(on)" : "(off)";
		const separator = theme.fg("muted", " · ");
		const primary =
			keyHint("tui.input.tab", "scope") + separator + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
		const secondaryParts = [
			keyHint("app.session.toggleSort", "sort"),
			keyHint("app.session.toggleNamedFilter", "named"),
			keyHint("app.session.delete", "delete"),
			keyHint("app.session.togglePath", `path ${pathState}`),
		];
		if (this.showRenameHint) secondaryParts.push(keyHint("app.session.rename", "rename"));
		return {
			primary: truncateToWidth(primary, width, "…"),
			secondary: truncateToWidth(secondaryParts.join(separator), width, "…"),
		};
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		const hints = this.renderHintLines(width);

		return [`${left}${" ".repeat(spacing)}${rightText}`, hints.primary, hints.secondary];
	}
}

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
}

/** Flattened node for display with tree structure info */
interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

interface SessionRowRenderOptions {
	width: number;
	prefix: string;
	isSelected: boolean;
	isConfirmingDelete: boolean;
	isCurrent: boolean;
	showCwd: boolean;
	showPath: boolean;
}

function getEmptySessionListMessage(nameFilter: NameFilter, showCwd: boolean): string {
	if (nameFilter === "named") {
		const toggleKey = keyText("app.session.toggleNamedFilter");
		return showCwd
			? `  No named sessions found. Press ${toggleKey} to show all.`
			: `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
	}
	return showCwd ? "  No sessions found" : "  No sessions in current folder. Press Tab to view all.";
}

function renderSessionRow(node: FlatSessionNode, options: SessionRowRenderOptions): string {
	const session = node.session;
	const displayText = session.name ?? session.firstMessage;
	const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const age = formatSessionDate(session.modified);
	let rightPart = `${session.messageCount} ${age}`;
	if (options.showCwd && session.cwd) rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
	if (options.showPath) rightPart = `${shortenPath(session.path)} ${rightPart}`;
	const cursor = options.isSelected ? theme.fg("accent", "› ") : "  ";
	const rightWidth = visibleWidth(rightPart) + 2;
	const availableForMessage = options.width - 2 - visibleWidth(options.prefix) - rightWidth;
	const truncatedMessage = truncateToWidth(normalizedMessage, Math.max(10, availableForMessage), "…");
	let messageColor: "error" | "warning" | "accent" | null = null;
	if (options.isConfirmingDelete) messageColor = "error";
	else if (options.isCurrent) messageColor = "accent";
	else if (session.name) messageColor = "warning";
	let styledMessage = messageColor ? theme.fg(messageColor, truncatedMessage) : truncatedMessage;
	if (options.isSelected) styledMessage = theme.bold(styledMessage);
	const leftPart = cursor + theme.fg("dim", options.prefix) + styledMessage;
	const spacing = Math.max(1, options.width - visibleWidth(leftPart) - visibleWidth(rightPart));
	const styledRight = theme.fg(options.isConfirmingDelete ? "error" : "dim", rightPart);
	let line = leftPart + " ".repeat(spacing) + styledRight;
	if (options.isSelected) line = theme.bg("selectedBg", line);
	return truncateToWidth(line, options.width);
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Sort children and roots by modified date (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [...this.searchInput.render(width), ""];
		if (this.filteredSessions.length === 0) {
			const emptyMessage = getEmptySessionListMessage(this.nameFilter, this.showCwd);
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);
		for (let index = startIndex; index < endIndex; index++) {
			const node = this.filteredSessions[index]!;
			lines.push(
				renderSessionRow(node, {
					width,
					prefix: this.buildTreePrefix(node),
					isSelected: index === this.selectedIndex,
					isConfirmingDelete: node.session.path === this.confirmingDeletePath,
					isCurrent: this.isCurrentSessionPath(node.session.path),
					showCwd: this.showCwd,
					showPath: this.showPath,
				}),
			);
		}
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			lines.push(theme.fg("muted", truncateToWidth(scrollText, width, "")));
		}
		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	private handleDeleteConfirmationInput(keyData: string): boolean {
		if (this.confirmingDeletePath === null) return false;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const pathToDelete = this.confirmingDeletePath;
			this.setConfirmingDeletePath(null);
			void this.onDeleteSession?.(pathToDelete);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.setConfirmingDeletePath(null);
		}
		return true;
	}

	private handleSessionActionInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			this.onToggleScope?.();
			return true;
		}
		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return true;
		}
		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return true;
		}
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return true;
		}
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return true;
		}
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) this.onRenameSession?.(selected.session.path);
			return true;
		}
		if (!kb.matches(keyData, "app.session.deleteNoninvasive")) return false;
		if (this.searchInput.getValue().length > 0) {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		} else {
			this.startDeleteConfirmationForSelectedSession();
		}
		return true;
	}

	private handleListNavigationInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) this.onSelect(selected.session.path);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}

	handleInput(keyData: string): void {
		if (this.handleDeleteConfirmationInput(keyData)) return;
		if (this.handleSessionActionInput(keyData)) return;
		this.handleListNavigationInput(keyData);
	}
}

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
async function deleteSessionFile(sessionPath: string): Promise<DeleteSessionResult> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessions: SessionInfo[] | null = null;
	private allSessions: SessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private onCancel: () => void;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	private currentLoading = false;
	private allLoading = false;
	private allLoadSeq = 0;

	private mode: SessionSelectorMode = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: SessionSelectorLayoutOptions): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: SessionSelectorOptions,
		currentSessionFilePath?: string,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.onCancel = onCancel;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" && this.currentLoading) return;
			if (this.scope === "all" && this.allLoading) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = (sessionPath) => this.deleteSession(sessionPath);

		// Start loading current sessions immediately
		this.loadCurrentSessions();
	}

	private removeDeletedSessionFromCaches(sessionPath: string): void {
		if (this.currentSessions) {
			this.currentSessions = this.currentSessions.filter((session) => session.path !== sessionPath);
		}
		if (this.allSessions) {
			this.allSessions = this.allSessions.filter((session) => session.path !== sessionPath);
		}
		const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
		this.sessionList.setSessions(sessions, this.scope === "all");
	}

	private async deleteSession(sessionPath: string): Promise<void> {
		const result = await deleteSessionFile(sessionPath);
		if (!result.ok) {
			const errorMessage = result.error ?? "Unknown error";
			this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			this.requestRender();
			return;
		}

		this.removeDeletedSessionFromCaches(sessionPath);
		const message = result.method === "trash" ? "Session moved to trash" : "Session deleted";
		this.header.setStatusMessage({ type: "info", message }, 2000);
		await this.refreshSessionsAfterMutation();
		this.requestRender();
	}

	private loadCurrentSessions(): void {
		void this.loadScope("current", "initial");
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} finally {
			this.exitRenameMode();
		}
	}

	private setScopeLoading(scope: SessionScope, loading: boolean): void {
		if (scope === "current") {
			this.currentLoading = loading;
		} else {
			this.allLoading = loading;
		}
	}

	private beginScopeLoad(scope: SessionScope, reason: SessionLoadReason): SessionScopeLoadContext {
		this.setScopeLoading(scope, true);
		const sequence = scope === "all" ? ++this.allLoadSeq : undefined;
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.requestRender();
		return { scope, reason, showCwd: scope === "all", sequence };
	}

	private isActiveScopeLoad(context: SessionScopeLoadContext): boolean {
		if (context.scope !== this.scope) return false;
		return context.sequence === undefined || context.sequence === this.allLoadSeq;
	}

	private createScopeLoadProgress(context: SessionScopeLoadContext): SessionListProgress {
		return (loaded, total) => {
			if (!this.isActiveScopeLoad(context)) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};
	}

	private finishScopeLoad(context: SessionScopeLoadContext, sessions: SessionInfo[]): void {
		if (context.scope === "current") {
			this.currentSessions = sessions;
		} else {
			this.allSessions = sessions;
		}
		this.setScopeLoading(context.scope, false);
		if (!this.isActiveScopeLoad(context)) return;
		this.header.setLoading(false);
		this.sessionList.setSessions(sessions, context.showCwd);
		this.requestRender();
		if (context.scope === "all" && sessions.length === 0 && (this.currentSessions?.length ?? 0) === 0) {
			this.onCancel();
		}
	}

	private failScopeLoad(context: SessionScopeLoadContext, error: unknown): void {
		this.setScopeLoading(context.scope, false);
		if (!this.isActiveScopeLoad(context)) return;
		const message = error instanceof Error ? error.message : String(error);
		this.header.setLoading(false);
		this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
		if (context.reason === "initial") this.sessionList.setSessions([], context.showCwd);
		this.requestRender();
	}

	private async loadScope(scope: SessionScope, reason: SessionLoadReason): Promise<void> {
		const context = this.beginScopeLoad(scope, reason);
		const onProgress = this.createScopeLoadProgress(context);
		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader(onProgress)
				: this.allSessionsLoader(onProgress));
			this.finishScopeLoad(context, sessions);
		} catch (error) {
			this.failScopeLoad(context, error);
		}
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async refreshSessionsAfterMutation(): Promise<void> {
		await this.loadScope(this.scope, "refresh");
	}

	private toggleScope(): void {
		if (this.scope === "current") {
			this.scope = "all";
			this.header.setScope(this.scope);

			if (this.allSessions !== null) {
				this.header.setLoading(false);
				this.sessionList.setSessions(this.allSessions, true);
				this.requestRender();
				return;
			}

			if (!this.allLoading) {
				void this.loadScope("all", "toggle");
			}
			return;
		}

		this.scope = "current";
		this.header.setScope(this.scope);
		this.header.setLoading(this.currentLoading);
		this.sessionList.setSessions(this.currentSessions ?? [], false);
		this.requestRender();
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}

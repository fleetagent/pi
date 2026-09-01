/**
 * Snake game extension - play snake with /snake command
 */

import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";
import { matchesKey, type TUI, visibleWidth } from "@fleetagent/pi-tui";

const GAME_WIDTH = 40;
const GAME_HEIGHT = 15;
const TICK_MS = 100;

type Direction = "up" | "down" | "left" | "right";
type Point = { x: number; y: number };

const OPPOSITE_DIRECTIONS: Record<Direction, Direction> = {
	up: "down",
	down: "up",
	left: "right",
	right: "left",
};

interface GameState {
	snake: Point[];
	food: Point;
	direction: Direction;
	nextDirection: Direction;
	score: number;
	gameOver: boolean;
	highScore: number;
}

function createInitialState(): GameState {
	const startX = Math.floor(GAME_WIDTH / 2);
	const startY = Math.floor(GAME_HEIGHT / 2);
	return {
		snake: [
			{ x: startX, y: startY },
			{ x: startX - 1, y: startY },
			{ x: startX - 2, y: startY },
		],
		food: spawnFood([{ x: startX, y: startY }]),
		direction: "right",
		nextDirection: "right",
		score: 0,
		gameOver: false,
		highScore: 0,
	};
}

type CellStyler = (text: string) => string;

interface SnakeCellRenderState {
	headPosition: number;
	bodyPositions: ReadonlySet<number>;
	foodPosition: number;
	green: CellStyler;
	red: CellStyler;
}

function pointKey(x: number, y: number): number {
	return y * GAME_WIDTH + x;
}

function renderSnakeCell(position: number, state: SnakeCellRenderState): string {
	if (position === state.headPosition) return state.green("██");
	if (state.bodyPositions.has(position)) return state.green("▓▓");
	if (position === state.foodPosition) return state.red("◆ ");
	return "  ";
}

function spawnFood(snake: Point[]): Point {
	const occupiedPositions = new Set<number>();
	for (const point of snake) occupiedPositions.add(pointKey(point.x, point.y));
	let food: Point;
	do {
		food = {
			x: Math.floor(Math.random() * GAME_WIDTH),
			y: Math.floor(Math.random() * GAME_HEIGHT),
		};
	} while (occupiedPositions.has(pointKey(food.x, food.y)));
	return food;
}

class SnakeComponent {
	private state: GameState;
	private interval: ReturnType<typeof setInterval> | null = null;
	private onClose: () => void;
	private onSave: (state: GameState | null) => void;
	private tui: TUI;
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;
	private paused: boolean;

	constructor(tui: TUI, onClose: () => void, onSave: (state: GameState | null) => void, savedState?: GameState) {
		this.tui = tui;
		if (savedState && !savedState.gameOver) {
			// Resume from saved state, start paused
			this.state = savedState;
			this.paused = true;
		} else {
			// New game or saved game was over
			this.state = createInitialState();
			if (savedState) {
				this.state.highScore = savedState.highScore;
			}
			this.paused = false;
			this.startGame();
		}
		this.onClose = onClose;
		this.onSave = onSave;
	}

	private startGame(): void {
		this.interval = setInterval(() => {
			if (!this.state.gameOver) {
				this.tick();
				this.version++;
				this.tui.requestRender();
			}
		}, TICK_MS);
	}

	private tick(): void {
		// Apply queued direction change
		this.state.direction = this.state.nextDirection;

		// Calculate new head position
		const head = this.state.snake[0];
		let newHead: Point;

		switch (this.state.direction) {
			case "up":
				newHead = { x: head.x, y: head.y - 1 };
				break;
			case "down":
				newHead = { x: head.x, y: head.y + 1 };
				break;
			case "left":
				newHead = { x: head.x - 1, y: head.y };
				break;
			case "right":
				newHead = { x: head.x + 1, y: head.y };
				break;
		}

		// Check wall collision
		if (newHead.x < 0 || newHead.x >= GAME_WIDTH || newHead.y < 0 || newHead.y >= GAME_HEIGHT) {
			this.state.gameOver = true;
			return;
		}

		// Check self collision
		if (this.state.snake.some((s) => s.x === newHead.x && s.y === newHead.y)) {
			this.state.gameOver = true;
			return;
		}

		// Move snake
		this.state.snake.unshift(newHead);

		// Check food collision
		if (newHead.x === this.state.food.x && newHead.y === this.state.food.y) {
			this.state.score += 10;
			if (this.state.score > this.state.highScore) {
				this.state.highScore = this.state.score;
			}
			this.state.food = spawnFood(this.state.snake);
		} else {
			this.state.snake.pop();
		}
	}

	private isQuitInput(data: string): boolean {
		return data === "q" || data === "Q";
	}

	private handlePausedInput(data: string): boolean {
		if (!this.paused) return false;
		if (matchesKey(data, "escape") || this.isQuitInput(data)) {
			this.dispose();
			this.onClose();
		} else {
			this.paused = false;
			this.startGame();
		}
		return true;
	}

	private handleActiveExit(data: string): boolean {
		if (matchesKey(data, "escape")) {
			this.dispose();
			this.onSave(this.state);
			this.onClose();
			return true;
		}
		if (!this.isQuitInput(data)) return false;
		this.dispose();
		this.onSave(null);
		this.onClose();
		return true;
	}

	private requestedDirection(data: string): Direction | undefined {
		if (matchesKey(data, "up") || data === "w" || data === "W") return "up";
		if (matchesKey(data, "down") || data === "s" || data === "S") return "down";
		if (matchesKey(data, "right") || data === "d" || data === "D") return "right";
		if (matchesKey(data, "left") || data === "a" || data === "A") return "left";
		return undefined;
	}

	private queueDirection(data: string): void {
		const direction = this.requestedDirection(data);
		if (direction && this.state.direction !== OPPOSITE_DIRECTIONS[direction]) {
			this.state.nextDirection = direction;
		}
	}

	private restartGame(data: string): void {
		if (!this.state.gameOver || (data !== "r" && data !== "R" && data !== " ")) return;
		const highScore = this.state.highScore;
		this.state = createInitialState();
		this.state.highScore = highScore;
		this.onSave(null);
		this.version++;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.handlePausedInput(data) || this.handleActiveExit(data)) return;
		this.queueDirection(data);
		this.restartGame(data);
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		// Each game cell is 2 chars wide to appear square (terminal cells are ~2:1 aspect)
		const cellWidth = 2;
		const effectiveWidth = Math.min(GAME_WIDTH, Math.floor((width - 4) / cellWidth));
		const effectiveHeight = GAME_HEIGHT;

		// Colors
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const boxWidth = effectiveWidth * cellWidth;

		// Helper to pad content inside box
		const boxLine = (content: string) => {
			const contentLen = visibleWidth(content);
			const padding = Math.max(0, boxWidth - contentLen);
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		// Top border
		lines.push(this.padLine(dim(` ╭${"─".repeat(boxWidth)}╮`), width));

		// Header with score
		const scoreText = `Score: ${bold(yellow(String(this.state.score)))}`;
		const highText = `High: ${bold(yellow(String(this.state.highScore)))}`;
		const title = `${bold(green("SNAKE"))} │ ${scoreText} │ ${highText}`;
		lines.push(this.padLine(boxLine(title), width));

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Game grid
		const headPosition = pointKey(this.state.snake[0].x, this.state.snake[0].y);
		const bodyPositions = new Set<number>();
		for (let index = 1; index < this.state.snake.length; index += 1) {
			const point = this.state.snake[index];
			bodyPositions.add(pointKey(point.x, point.y));
		}
		const cellRenderState: SnakeCellRenderState = {
			headPosition,
			bodyPositions,
			foodPosition: pointKey(this.state.food.x, this.state.food.y),
			green,
			red,
		};
		const gridStride = Math.max(1, effectiveWidth);
		const gridCellCount = gridStride * effectiveHeight;
		let row = "";
		for (let cellIndex = 0; cellIndex < gridCellCount; cellIndex += 1) {
			const x = cellIndex % gridStride;
			const position = pointKey(x, Math.floor(cellIndex / gridStride));
			if (effectiveWidth > 0) row += renderSnakeCell(position, cellRenderState);
			if (x !== gridStride - 1) continue;
			lines.push(this.padLine(dim(" │") + row + dim("│"), width));
			row = "";
		}

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Footer
		let footer: string;
		if (this.paused) {
			footer = `${yellow(bold("PAUSED"))} Press any key to continue, ${bold("Q")} to quit`;
		} else if (this.state.gameOver) {
			footer = `${red(bold("GAME OVER!"))} Press ${bold("R")} to restart, ${bold("Q")} to quit`;
		} else {
			footer = `↑↓←→ or WASD to move, ${bold("ESC")} pause, ${bold("Q")} quit`;
		}
		lines.push(this.padLine(boxLine(footer), width));

		// Bottom border
		lines.push(this.padLine(dim(` ╰${"─".repeat(boxWidth)}╯`), width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return lines;
	}

	private padLine(line: string, width: number): string {
		// Calculate visible length (strip ANSI codes)
		const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
		const padding = Math.max(0, width - visibleLen);
		return line + " ".repeat(padding);
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

const SNAKE_SAVE_TYPE = "snake-save";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("snake", {
		description: "Play Snake!",

		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Snake requires interactive mode", "error");
				return;
			}

			// Load saved state from session
			const entries = ctx.session.getEntries();
			let savedState: GameState | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "custom" && entry.customType === SNAKE_SAVE_TYPE) {
					savedState = entry.data as GameState;
					break;
				}
			}

			await ctx.ui.custom((tui, _theme, _kb, done) => {
				return new SnakeComponent(
					tui,
					() => done(undefined),
					(state) => {
						// Save or clear state
						pi.appendEntry(SNAKE_SAVE_TYPE, state);
					},
					savedState,
				);
			});
		},
	});
}

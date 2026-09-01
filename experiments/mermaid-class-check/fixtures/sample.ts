import type { Clock } from "./clock.ts";

export interface Identifiable {
	id: string;
}

export class User implements Identifiable {
	public id: string = "user-1";
	public name: string = "Example User";
	private token: string = "secret";
	public sessions: Session[] = [];

	public login(password: string): boolean {
		return password === this.token;
	}

	public async refresh(): Promise<void> {}
}

export class Session implements Identifiable {
	public id: string = "session-1";
	public createdAt: Date = new Date();
	public messages: Message[] = [];

	public addMessage(message: Message): void {
		this.messages.push(message);
	}
}

export class BaseMessage {
	public timestamp: Date = new Date();
}

export class Message extends BaseMessage {
	public content: string = "Hello";

	public send(): void {}
}

export async function createSession(user: User, clock: Clock): Promise<Session> {
	const session = new Session();
	session.createdAt = clock.now();
	user.sessions.push(session);
	return session;
}

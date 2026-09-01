class Identifiable {
	public id: string = "identity";
}

export class User {
	public id: number = 1;
	public name: string = "Example User";
	public sessions: Session = new Session();

	private login(password: string): string {
		return password;
	}

	public exerciseLogin(): string {
		return this.login("password");
	}
}

export class Session {
	public id: string = "session-1";
	public createdAt: Date = new Date();

	public addMessage(message: Message): void {
		void message;
	}
}

export class BaseMessage {
	public timestamp: Date = new Date();
}

export class Message {
	public content: string = "Hello";

	public send(): void {}
}

function createSession(user: User): Session {
	void user;
	return new Session();
}

void Identifiable;
void createSession;

let buffer = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function consume() {
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const match = /(?:^|\r\n)Content-Length: (\d+)/i.exec(header);
		if (!match) process.exit(2);
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
		buffer = buffer.subarray(bodyStart + length);
		if (message.method === "initialize" && !process.argv.includes("--no-initialize")) {
			process.stderr.write("faux server ready\n");
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } });
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			process.exit(0);
		}
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	consume();
});

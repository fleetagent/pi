import { writeFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
let documentText = "";
const exitMarkerArgument = process.argv.find((argument) => argument.startsWith("--exit-marker="));
const exitMarker = exitMarkerArgument?.slice("--exit-marker=".length);

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
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					capabilities: {
						hoverProvider: true,
						textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
					},
				},
			});
		} else if (message.method === "textDocument/didOpen") {
			documentText = message.params?.textDocument?.text ?? "";
		} else if (message.method === "textDocument/didChange") {
			documentText = message.params?.contentChanges?.at(-1)?.text ?? documentText;
		} else if (message.method === "textDocument/hover" && !process.argv.includes("--hang-hover")) {
			send({ jsonrpc: "2.0", id: message.id, result: { contents: `fixture hover: ${documentText}` } });
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			if (exitMarker) writeFileSync(exitMarker, "exited");
			process.exit(0);
		}
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	consume();
});

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
	DAEMON_WEBSOCKET_PATH,
	DAEMON_WEBSOCKET_PROTOCOL,
	type DaemonConfiguration,
	DaemonConfigurationError,
} from "./config.ts";

export interface DaemonAuthorization {
	readonly configuredBytes: number;
	readonly digest: Buffer;
}

export interface DaemonUpgradeDecision {
	readonly accepted: boolean;
	readonly status: number;
	readonly message: string;
}

function headerValues(request: IncomingMessage, name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
	}
	return values;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
	const values = headerValues(request, name);
	return values.length === 1 ? values[0] : undefined;
}

function hasToken(value: string, token: string): boolean {
	return value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.includes(token);
}

function isValidWebSocketKey(value: string): boolean {
	if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
	return Buffer.from(value, "base64").byteLength === 16;
}

export function isLoopbackBind(host: string): boolean {
	const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
	if (isIP(normalized) !== 6) return false;
	const lower = normalized.toLowerCase();
	return lower === "::1" || /^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(lower);
}
function validateDaemonRuntimeLimits(configuration: DaemonConfiguration): void {
	if (!Number.isSafeInteger(configuration.port) || configuration.port < 0 || configuration.port > 65535) {
		throw new DaemonConfigurationError("Daemon server port must be an integer from 0 to 65535");
	}
	if (!Number.isSafeInteger(configuration.maxConnections) || configuration.maxConnections < 1) {
		throw new DaemonConfigurationError("Daemon maxConnections must be a positive integer");
	}
	if (!Number.isSafeInteger(configuration.maxPendingConnections) || configuration.maxPendingConnections < 1) {
		throw new DaemonConfigurationError("Daemon maxPendingConnections must be a positive integer");
	}
	if (
		!Number.isSafeInteger(configuration.handshakeTimeoutMs) ||
		configuration.handshakeTimeoutMs < 100 ||
		configuration.handshakeTimeoutMs > 5 * 60_000
	) {
		throw new DaemonConfigurationError("Daemon handshakeTimeoutMs must be an integer from 100 to 300000");
	}
	if (
		!Number.isSafeInteger(configuration.shutdownTimeoutMs) ||
		configuration.shutdownTimeoutMs < 100 ||
		configuration.shutdownTimeoutMs > 5 * 60_000
	) {
		throw new DaemonConfigurationError("Daemon shutdownTimeoutMs must be an integer from 100 to 300000");
	}
}

function validateDaemonCredentials(configuration: DaemonConfiguration): void {
	if (process.platform !== "win32" && process.getuid?.() === 0 && !configuration.allowRoot) {
		throw new DaemonConfigurationError("Refusing to run the workspace daemon as root without allowRoot");
	}
	if (configuration.token === undefined) return;
	const tokenBytes = Buffer.byteLength(configuration.token, "utf8");
	if (
		tokenBytes < 32 ||
		tokenBytes > 1024 ||
		!/\S/u.test(configuration.token) ||
		/[\r\n]/u.test(configuration.token)
	) {
		throw new DaemonConfigurationError("Daemon token must contain 32 to 1024 UTF-8 bytes and no line breaks");
	}
}

function validateDaemonOrigins(origins: readonly string[]): void {
	for (const origin of origins) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			throw new DaemonConfigurationError(`Invalid daemon Origin: ${origin}`);
		}
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || origin !== parsed.origin) {
			throw new DaemonConfigurationError(`Invalid daemon Origin: ${origin}`);
		}
	}
}

function validateDaemonTls(configuration: DaemonConfiguration): void {
	if (configuration.tls && (configuration.tls.cert.byteLength === 0 || configuration.tls.key.byteLength === 0)) {
		throw new DaemonConfigurationError("Daemon TLS certificate and private key must not be empty");
	}
}

function validateDaemonBindExposure(configuration: DaemonConfiguration): void {
	if (isIP(configuration.host.replace(/^\[|\]$/g, "")) === 0) {
		throw new DaemonConfigurationError("Daemon host must be a literal IPv4 or IPv6 address");
	}
	if (isLoopbackBind(configuration.host)) return;
	if (!configuration.token) throw new DaemonConfigurationError("A non-loopback daemon bind requires PI_DAEMON_TOKEN");
	if (!configuration.tls && !configuration.allowInsecureTransport) {
		throw new DaemonConfigurationError(
			"A non-loopback daemon bind requires TLS or explicit --daemon-allow-insecure-transport acknowledgement",
		);
	}
}

export function validateDaemonNetworkPolicy(configuration: DaemonConfiguration): void {
	validateDaemonRuntimeLimits(configuration);
	validateDaemonCredentials(configuration);
	validateDaemonOrigins(configuration.allowedOrigins);
	validateDaemonTls(configuration);
	validateDaemonBindExposure(configuration);
}

export function createDaemonAuthorization(token: string | undefined): DaemonAuthorization | undefined {
	if (token === undefined) return undefined;
	const bytes = Buffer.from(token, "utf8");
	return Object.freeze({ configuredBytes: bytes.byteLength, digest: createHash("sha256").update(bytes).digest() });
}

function authenticateAuthorizationHeader(
	value: string | undefined,
	authorization: DaemonAuthorization | undefined,
): boolean {
	if (!authorization) return value === undefined;
	if (!value?.startsWith("Bearer ")) return false;
	const presented = Buffer.from(value.slice("Bearer ".length), "utf8");
	const digest = createHash("sha256").update(presented).digest();
	return presented.byteLength === authorization.configuredBytes && timingSafeEqual(digest, authorization.digest);
}

export function validateDaemonUpgrade(
	request: IncomingMessage,
	configuration: DaemonConfiguration,
	authorization: DaemonAuthorization | undefined,
): DaemonUpgradeDecision {
	if (request.method !== "GET" || request.url !== DAEMON_WEBSOCKET_PATH) {
		return { accepted: false, status: 404, message: "Not found" };
	}
	const upgrade = singleHeader(request, "upgrade");
	const connection = singleHeader(request, "connection");
	const version = singleHeader(request, "sec-websocket-version");
	const key = singleHeader(request, "sec-websocket-key");
	const protocol = singleHeader(request, "sec-websocket-protocol");
	if (
		upgrade?.toLowerCase() !== "websocket" ||
		!connection ||
		!hasToken(connection, "upgrade") ||
		version !== "13" ||
		!key ||
		!isValidWebSocketKey(key) ||
		protocol !== DAEMON_WEBSOCKET_PROTOCOL
	) {
		return { accepted: false, status: 400, message: "Invalid WebSocket upgrade" };
	}
	const originValues = headerValues(request, "origin");
	if (originValues.length > 1) return { accepted: false, status: 403, message: "Origin not allowed" };
	if (originValues.length === 1 && !configuration.allowedOrigins.includes(originValues[0])) {
		return { accepted: false, status: 403, message: "Origin not allowed" };
	}
	const authorizationValues = headerValues(request, "authorization");
	if (authorizationValues.length > 1 || !authenticateAuthorizationHeader(authorizationValues[0], authorization)) {
		return { accepted: false, status: 401, message: "Unauthorized" };
	}
	return { accepted: true, status: 101, message: "Switching Protocols" };
}

export function rejectDaemonUpgrade(socket: Duplex, decision: DaemonUpgradeDecision): void {
	const statusText =
		new Map([
			[400, "Bad Request"],
			[401, "Unauthorized"],
			[403, "Forbidden"],
			[404, "Not Found"],
			[503, "Service Unavailable"],
		]).get(decision.status) ?? "Rejected";
	const body = `${decision.message}\n`;
	socket.end(
		`HTTP/1.1 ${decision.status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	);
}

export function redactDaemonText(value: string, secrets: readonly (string | undefined)[]): string {
	let result = value
		.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
		.replace(/([?&](?:token|key|secret|password|credential)=)[^&#\s]*/giu, "$1[REDACTED]")
		.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/gu, "$1[REDACTED]@");
	for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
	return result;
}

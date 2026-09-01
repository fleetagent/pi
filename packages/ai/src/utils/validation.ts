import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

const validatorCache = new WeakMap<object, Validator>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return isRecord(value);
}

function hasTypeBoxMetadata(schema: unknown): boolean {
	return (
		isRecord(schema) &&
		(typeof schema["~kind"] === "string" || Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND))
	);
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value) && !Array.isArray(value);
		default:
			return false;
	}
}

function isValidatorSchema(value: unknown): value is TSchema {
	return isRecord(value);
}

function getSubSchemaValidator(schema: JsonSchemaObject): Validator | undefined {
	if (!isValidatorSchema(schema)) {
		return undefined;
	}
	try {
		return getValidator(schema);
	} catch {
		return undefined;
	}
}

function coerceJsonNumber(value: unknown): unknown {
	if (value === null) return 0;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

function coerceJsonInteger(value: unknown): unknown {
	if (value === null) return 0;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isInteger(parsed)) return parsed;
	}
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

function coerceJsonBoolean(value: unknown): unknown {
	if (value === null) return false;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;
	return value;
}

function coerceJsonString(value: unknown): unknown {
	if (value === null) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return value;
}

function coerceJsonNull(value: unknown): unknown {
	return value === "" || value === 0 || value === false ? null : value;
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number":
			return coerceJsonNumber(value);
		case "integer":
			return coerceJsonInteger(value);
		case "boolean":
			return coerceJsonBoolean(value);
		case "string":
			return coerceJsonString(value);
		case "null":
			return coerceJsonNull(value);
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (isJsonSchemaObject(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}

	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function applyCombinedSchemaCoercion(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;
	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) nextValue = coerceWithJsonSchema(nextValue, nested);
	}
	if (Array.isArray(schema.anyOf)) nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	if (Array.isArray(schema.oneOf)) nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	return nextValue;
}

function coerceToDeclaredSchemaType(value: unknown, schemaTypes: string[]): unknown {
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(value, schemaType));
	if (schemaTypes.length === 0 || matchesUnionMember) return value;
	for (const schemaType of schemaTypes) {
		const candidate = coercePrimitiveByType(value, schemaType);
		if (candidate !== value) return candidate;
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = applyCombinedSchemaCoercion(value, schema);
	const schemaTypes = getSchemaTypes(schema);
	nextValue = coerceToDeclaredSchemaType(nextValue, schemaTypes);

	if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) {
		applySchemaObjectCoercion(nextValue, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function getValidator(schema: TSchema): Validator {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

interface SerializedSchemaValidationResult {
	valid: boolean;
	value: unknown;
}

function validateSerializedSchemaArguments(
	args: unknown,
	schema: TSchema,
	validator: Validator,
): SerializedSchemaValidationResult {
	if (hasTypeBoxMetadata(schema) || !isJsonSchemaObject(schema)) return { valid: false, value: args };
	const coerced = coerceWithJsonSchema(args, schema);
	if (coerced !== args) {
		if (isRecord(args) && isRecord(coerced)) {
			for (const key of Object.keys(args)) delete args[key];
			Object.assign(args, coerced);
		} else if (validator.Check(coerced)) {
			return { valid: true, value: coerced };
		}
	}
	return { valid: validator.Check(args), value: args };
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	const validator = getValidator(tool.parameters);

	// Serialized schemas use the compatibility coercer first so valid union arms are not changed
	// by TypeBox conversion before the schema-specific checks can preserve them.
	const serializedValidation = validateSerializedSchemaArguments(args, tool.parameters, validator);
	if (serializedValidation.valid) return serializedValidation.value;

	Value.Convert(tool.parameters, args);
	if (validator.Check(args)) {
		return args;
	}

	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}

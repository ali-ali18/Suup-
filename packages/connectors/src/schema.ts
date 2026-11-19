// Owns turning the JSON Schema a server gives for a tool's input into a zod schema the registry can
// validate with and show to the model. The schema is untrusted: it may be huge, deeply nested,
// recursive, or use constructs this harness does not model. Only a bounded, well-understood subset
// is accepted; anything else is refused with a message that says which construct and where, and the
// tool is left out (the rest of the connector keeps working). The schema the MODEL sees is never
// the server's text: it is generated from the converted zod schema, so only what was understood
// reaches it, with descriptions cleaned and bounded.
import { z } from "zod";
import { cleanDescription, stripControl } from "./text.js";

export const MAX_SCHEMA_CHARS = 32_000;
export const MAX_SCHEMA_DEPTH = 8;
export const MAX_SCHEMA_NODES = 400;
export const MAX_ENUM_VALUES = 200;
export const MAX_UNION_BRANCHES = 16;
export const MAX_PROPERTY_NAME = 100;
export const MAX_FIELD_DESCRIPTION = 400;

/** The schema cannot be used. The message says why, for the person who reads `suup connectors tools`. */
export class UnsupportedSchemaError extends Error {
  override readonly name = "UnsupportedSchemaError";
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords that change which values are valid in a way this converter does not model. */
const REFUSED = [
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "contains",
  "prefixItems",
  "$dynamicRef",
  "$recursiveRef",
] as const;

/** Keywords that are only descriptive, or only narrow what the server checks again anyway. */
const IGNORED = new Set([
  "$schema",
  "$id",
  "$comment",
  "$anchor",
  "title",
  "description",
  "default",
  "examples",
  "example",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "pattern",
  "uniqueItems",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "contentEncoding",
  "contentMediaType",
  "$defs",
  "definitions",
]);

interface Walk {
  nodes: number;
  root: Json;
  /** `$ref` targets being resolved right now (a cycle is refused, not followed). */
  resolving: string[];
}

/**
 * Converts the input schema of a tool. Throws `UnsupportedSchemaError`. The top level must be an
 * object (that is what the protocol requires of a tool).
 */
export function inputSchemaToZod(schema: unknown): z.ZodType<Record<string, unknown>> {
  if (!isObject(schema)) {
    throw new UnsupportedSchemaError(
      "o esquema de entrada não está disponível ou não é um objeto JSON (grande demais para ser guardado?)",
    );
  }
  let size: number;
  try {
    size = JSON.stringify(schema).length;
  } catch {
    throw new UnsupportedSchemaError(
      "o esquema de entrada não pode ser lido (referência circular)",
    );
  }
  if (size > MAX_SCHEMA_CHARS) {
    throw new UnsupportedSchemaError(
      `o esquema de entrada é grande demais (${size} caracteres; o limite é ${MAX_SCHEMA_CHARS})`,
    );
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new UnsupportedSchemaError(
      `o esquema de entrada deve descrever um objeto (type: ${JSON.stringify(schema.type)})`,
    );
  }
  const walk: Walk = { nodes: 0, root: schema, resolving: [] };
  // A schema with no `type` at the top is an object with whatever properties it lists.
  const converted = convert(
    schema.type === undefined ? { ...schema, type: "object" } : schema,
    walk,
    0,
    "(raiz)",
  );
  if (!(converted instanceof z.ZodObject)) {
    throw new UnsupportedSchemaError(
      "o esquema de entrada deve descrever um objeto (anyOf/oneOf na raiz não é suportado)",
    );
  }
  return converted as unknown as z.ZodType<Record<string, unknown>>;
}

function convert(node: unknown, walk: Walk, depth: number, where: string): z.ZodType {
  if (node === true) return z.unknown();
  if (!isObject(node)) {
    throw new UnsupportedSchemaError(`${where}: um esquema deve ser um objeto (ou true)`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new UnsupportedSchemaError(`${where}: aninhamento acima de ${MAX_SCHEMA_DEPTH} níveis`);
  }
  walk.nodes += 1;
  if (walk.nodes > MAX_SCHEMA_NODES) {
    throw new UnsupportedSchemaError(`o esquema tem partes demais (mais de ${MAX_SCHEMA_NODES})`);
  }
  for (const key of REFUSED) {
    if (key in node) {
      throw new UnsupportedSchemaError(`${where}: a palavra-chave "${key}" não é suportada`);
    }
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("$") && !IGNORED.has(key) && key !== "$ref") {
      throw new UnsupportedSchemaError(`${where}: a palavra-chave "${key}" não é suportada`);
    }
  }

  let result: z.ZodType;
  if (typeof node.$ref === "string") {
    result = resolveRef(node.$ref, walk, depth, where);
  } else if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const branches = (node.anyOf ?? node.oneOf) as unknown[];
    if (branches.length === 0 || branches.length > MAX_UNION_BRANCHES) {
      throw new UnsupportedSchemaError(
        `${where}: anyOf/oneOf com ${branches.length} alternativas (aceito: 1 a ${MAX_UNION_BRANCHES})`,
      );
    }
    const members = branches.map((b, i) => convert(b, walk, depth + 1, `${where}.anyOf[${i}]`));
    result =
      members.length === 1
        ? (members[0] as z.ZodType)
        : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  } else if ("const" in node) {
    result = literalOf(node.const, where);
  } else if (Array.isArray(node.enum)) {
    result = enumOf(node.enum, where);
  } else if (Array.isArray(node.type)) {
    const types = node.type as unknown[];
    if (types.length === 0 || types.length > 7) {
      throw new UnsupportedSchemaError(`${where}: "type" inválido`);
    }
    const members = types.map((t) => byType(t, node, walk, depth, where));
    result =
      members.length === 1
        ? (members[0] as z.ZodType)
        : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  } else if (node.type !== undefined) {
    result = byType(node.type, node, walk, depth, where);
  } else if (
    isObject(node.properties) ||
    node.additionalProperties !== undefined ||
    Array.isArray(node.required)
  ) {
    result = byType("object", node, walk, depth, where);
  } else if (isObject(node.items)) {
    result = byType("array", node, walk, depth, where);
  } else {
    // No constraint at all: anything goes (the server validates it).
    result = z.unknown();
  }
  if (typeof node.description === "string") {
    const text = cleanDescription(node.description, MAX_FIELD_DESCRIPTION);
    if (text !== "") result = result.describe(text);
  }
  return result;
}

function resolveRef(ref: string, walk: Walk, depth: number, where: string): z.ZodType {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (match === null) {
    throw new UnsupportedSchemaError(
      `${where}: "$ref" só pode apontar para #/$defs/... ou #/definitions/... do próprio esquema (recebido: ${JSON.stringify(ref.slice(0, 80))})`,
    );
  }
  const table = walk.root[match[1] as string];
  const target = isObject(table) ? table[decodeURIComponent(match[2] as string)] : undefined;
  if (target === undefined) {
    throw new UnsupportedSchemaError(
      `${where}: "$ref" aponta para algo que não existe (${JSON.stringify(ref.slice(0, 80))})`,
    );
  }
  if (walk.resolving.includes(ref)) {
    throw new UnsupportedSchemaError(
      `${where}: esquema recursivo ("${ref.slice(0, 80)}" se refere a si mesmo); não é suportado`,
    );
  }
  walk.resolving.push(ref);
  try {
    return convert(target, walk, depth + 1, `${where}→${ref.slice(0, 60)}`);
  } finally {
    walk.resolving.pop();
  }
}

function literalOf(value: unknown, where: string): z.ZodType {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return z.literal(value as string | number | boolean | null);
  }
  throw new UnsupportedSchemaError(`${where}: "const" só aceita texto, número, booleano ou null`);
}

function enumOf(values: unknown[], where: string): z.ZodType {
  if (values.length === 0 || values.length > MAX_ENUM_VALUES) {
    throw new UnsupportedSchemaError(
      `${where}: enum com ${values.length} valores (aceito: 1 a ${MAX_ENUM_VALUES})`,
    );
  }
  const literals = values.map((v) => literalOf(v, `${where}.enum`));
  if (values.every((v) => typeof v === "string") && new Set(values).size === values.length) {
    return z.enum(values as [string, ...string[]]);
  }
  return literals.length === 1
    ? (literals[0] as z.ZodType)
    : z.union(literals as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function num(node: Json, key: string, where: string): number | undefined {
  const v = node[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new UnsupportedSchemaError(`${where}: "${key}" deve ser um número`);
  }
  return v;
}

function byType(type: unknown, node: Json, walk: Walk, depth: number, where: string): z.ZodType {
  switch (type) {
    case "string": {
      let s = z.string();
      const min = num(node, "minLength", where);
      const max = num(node, "maxLength", where);
      if (min !== undefined) s = s.min(Math.max(0, Math.floor(min)));
      if (max !== undefined) s = s.max(Math.max(0, Math.floor(max)));
      return s;
    }
    case "number":
    case "integer": {
      let n = type === "integer" ? z.number().int() : z.number();
      const min = num(node, "minimum", where);
      const max = num(node, "maximum", where);
      const exMin = num(node, "exclusiveMinimum", where);
      const exMax = num(node, "exclusiveMaximum", where);
      if (min !== undefined) n = n.min(min);
      if (max !== undefined) n = n.max(max);
      if (exMin !== undefined) n = n.gt(exMin);
      if (exMax !== undefined) n = n.lt(exMax);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      if (Array.isArray(node.items)) {
        throw new UnsupportedSchemaError(`${where}: "items" como lista (tupla) não é suportado`);
      }
      const item =
        node.items === undefined ? z.unknown() : convert(node.items, walk, depth + 1, `${where}[]`);
      let a = z.array(item);
      const min = num(node, "minItems", where);
      const max = num(node, "maxItems", where);
      if (min !== undefined) a = a.min(Math.max(0, Math.floor(min)));
      if (max !== undefined) a = a.max(Math.max(0, Math.floor(max)));
      return a;
    }
    case "object":
      return objectOf(node, walk, depth, where);
    default:
      throw new UnsupportedSchemaError(
        `${where}: tipo não suportado (${JSON.stringify(String(type).slice(0, 40))})`,
      );
  }
}

function objectOf(node: Json, walk: Walk, depth: number, where: string): z.ZodType {
  const props = node.properties === undefined ? {} : node.properties;
  if (!isObject(props))
    throw new UnsupportedSchemaError(`${where}: "properties" deve ser um objeto`);
  const required = new Set<string>();
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string")) {
      throw new UnsupportedSchemaError(`${where}: "required" deve ser uma lista de nomes`);
    }
    for (const r of node.required as string[]) required.add(r);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [name, child] of Object.entries(props)) {
    if (
      name.length === 0 ||
      name.length > MAX_PROPERTY_NAME ||
      stripControl(name) !== name ||
      name !== name.trim()
    ) {
      throw new UnsupportedSchemaError(
        `${where}: nome de propriedade inválido (vazio, longo demais ou com caracteres de controle)`,
      );
    }
    let converted = convert(child, walk, depth + 1, `${where}.${name}`);
    if (required.has(name)) {
      // `unknown` would accept a missing key; a required one must be there.
      if (converted instanceof z.ZodUnknown) {
        converted = converted.refine((v) => v !== undefined, "obrigatório");
      }
      shape[name] = converted;
    } else {
      shape[name] = converted.optional();
    }
  }
  for (const r of required) {
    if (!(r in shape)) {
      // Required but not described: any value, but it must be there.
      shape[r] = z.unknown().refine((v) => v !== undefined, "obrigatório");
    }
  }
  const extra = node.additionalProperties;
  if (extra === false) return z.strictObject(shape);
  if (isObject(extra))
    return z.object(shape).catchall(convert(extra, walk, depth + 1, `${where}.*`));
  return z.looseObject(shape);
}

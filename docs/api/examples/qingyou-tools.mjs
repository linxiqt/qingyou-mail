// Node.js 24. Provider-neutral example: these are HTTP tools, not an AI model.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const spec = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
);
const defaults = [
  "listMail",
  "getMail",
  "sendMail",
  "listCodes",
  "updateMail",
  "restoreMail",
  "deleteMailPermanently",
  "batchUpdateMail",
];
const operations = new Map(
  Object.entries(spec.paths).flatMap(([route, methods]) =>
    Object.entries(methods).map(([method, operation]) => [
      operation.operationId,
      { route, method: method.toUpperCase(), ...operation },
    ]),
  ),
);

function expand(schema) {
  if (Array.isArray(schema)) return schema.map(expand);
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (!spec.components.schemas[name])
      throw new Error("Unknown schema reference");
    return expand(spec.components.schemas[name]);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, expand(value)]),
  );
}
function inputSchema(op) {
  const properties = {},
    required = [];
  for (const location of ["query", "path"]) {
    const params = (op.parameters || []).filter((p) => p.in === location);
    if (!params.length) continue;
    const requiredParams = params.filter((p) => p.required).map((p) => p.name);
    properties[location] = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        params.map((p) => [p.name, expand(p.schema)]),
      ),
      ...(requiredParams.length ? { required: requiredParams } : {}),
    };
    if (requiredParams.length) required.push(location);
  }
  if (op.requestBody) {
    properties.body = expand(op.requestBody.content["application/json"].schema);
    if (op.requestBody.required) required.push("body");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

// Small validator for the request-schema subset used here. The server remains
// authoritative; this catches malformed tool calls before making a request.
function validate(value, schema, label = "arguments") {
  if (value === null && schema.nullable) return;
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => {
      try {
        validate(value, s, label);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new Error(`${label}: does not match a supported input shape`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${label}: unsupported value`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${label}: expected object`);
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw new Error(`${label}.${key}: required`);
    if (Object.keys(value).length < (schema.minProperties || 0))
      throw new Error(`${label}: empty object`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false)
          throw new Error(`${label}: unknown field`);
      } else validate(item, schema.properties[key], `${label}.${key}`);
    }
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems || 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new Error(`${label}: invalid array length`);
    value.forEach((item, index) =>
      validate(item, schema.items, `${label}[${index}]`),
    );
  } else if (schema.type === "integer" || schema.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      throw new Error(`${label}: invalid number`);
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < (schema.minLength || 0) ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      throw new Error(`${label}: invalid string`);
  } else if (schema.type === "boolean" && typeof value !== "boolean")
    throw new Error(`${label}: expected boolean`);
}

export function createQingyouClient({
  baseUrl,
  apiKey,
  allowedOperations = defaults,
  allowLocalHttp = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl || !apiKey)
    throw new Error("Set QINGYOU_BASE_URL and QINGYOU_API_KEY");
  const base = new URL(baseUrl);
  const localTest =
    allowLocalHttp &&
    base.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (!localTest && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error(
      "baseUrl must be an HTTPS origin, with optional port and without /api",
    );
  if (!/^po_[A-Za-z0-9_-]+$/.test(apiKey))
    throw new Error("Expected a Qingyou po_ API key");
  if (
    !Array.isArray(allowedOperations) ||
    allowedOperations.some((name) => !operations.has(name))
  )
    throw new Error("Unknown operation in allowlist");
  const allowed = new Set(allowedOperations);
  return {
    describeTools() {
      return [...allowed].map((name) => {
        const op = operations.get(name);
        return {
          name,
          description: `${op.summary}。${op.description}`,
          inputSchema: inputSchema(op),
        };
      });
    },
    async invoke(name, args = {}, { approvedByUser = false } = {}) {
      if (!allowed.has(name))
        throw new Error("Operation is not allowed by this client");
      const op = operations.get(name);
      validate(args, inputSchema(op));
      if (op["x-requires-confirmation"] && approvedByUser !== true)
        throw new Error(
          "WRITE_APPROVAL_REQUIRED: the host application must authorize this exact action",
        );
      const route = op.route.replace(/\{([^}]+)\}/g, (_, key) =>
        encodeURIComponent(String(args.path[key])),
      );
      const url = new URL(route, base.origin);
      for (const [key, value] of Object.entries(args.query || {}))
        url.searchParams.set(key, String(value));
      let response;
      try {
        response = await fetchImpl(url, {
          method: op.method,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            ...(args.body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(args.body !== undefined
            ? { body: JSON.stringify(args.body) }
            : {}),
        });
        if (!response.ok) {
          const text = await response.text();
          let detail;
          try {
            detail = JSON.parse(text);
          } catch {
            detail = { error: "Non-JSON response from server or proxy" };
          }
          const error = new Error(
            `HTTP ${response.status}: ${String(detail.error || "Request failed").slice(0, 500)}`,
          );
          error.status = response.status;
          error.code = detail.code;
          error.retryAfter = response.headers.get("retry-after");
          error.outcomeUncertain =
            op["x-requires-confirmation"] && response.status >= 500;
          throw error;
        }
        const type = response.headers.get("content-type") || "";
        if (type.includes("application/json")) return await response.json();
        if (["downloadMail", "downloadAttachment"].includes(name))
          return {
            contentType: type,
            contentDisposition: response.headers.get("content-disposition"),
            content: Buffer.from(await response.arrayBuffer()).toString(
              "base64",
            ),
          };
        throw new Error("Expected a JSON API response");
      } catch (cause) {
        if (cause.status) throw cause;
        const error = new Error(
          op["x-requires-confirmation"]
            ? "REQUEST_OUTCOME_UNKNOWN: verify server state before retrying this write"
            : "REQUEST_FAILED: check connectivity, TLS trust and server availability",
          { cause },
        );
        error.outcomeUncertain = Boolean(op["x-requires-confirmation"]);
        throw error;
      }
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [name, raw = "{}"] = process.argv.slice(2);
  if (!name)
    console.log(
      'Usage: node examples/qingyou-tools.mjs listMail \'{"query":{"email":"alice@example.com","limit":10}}\'\nSet QINGYOU_BASE_URL and QINGYOU_API_KEY. CLI runs non-mutating tools only.',
    );
  else {
    try {
      const client = createQingyouClient({
        baseUrl: process.env.QINGYOU_BASE_URL,
        apiKey: process.env.QINGYOU_API_KEY,
      });
      console.log(
        JSON.stringify(await client.invoke(name, JSON.parse(raw)), null, 2),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

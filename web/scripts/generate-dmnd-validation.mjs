import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

// Only structural keywords are shipped; endpoint prose and examples stay out.
const document = yaml.load(
  readFileSync(
    new URL("../contracts/dmnd.openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const source = document.components.schemas;
const schemas = {};
const supported = new Set([
  "type",
  "required",
  "properties",
  "$ref",
  "format",
  "description",
  "items",
  "enum",
  "oneOf",
  "allOf",
  "minimum",
  "additionalProperties",
]);
function project(schema) {
  for (const key of Object.keys(schema))
    if (!supported.has(key))
      throw new Error(`Unsupported schema keyword: ${key}`);
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (key === "$ref") {
      const prefix = "#/components/schemas/";
      if (!value.startsWith(prefix))
        throw new Error("External schema references are not supported");
      include(value.slice(prefix.length));
      result[key] = value;
    } else if (key === "properties")
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, project(child)]),
      );
    else if (
      key === "items" ||
      (key === "additionalProperties" && typeof value === "object")
    )
      result[key] = project(value);
    else if (key === "oneOf" || key === "allOf")
      result[key] = value.map(project);
    else result[key] = value;
  }
  return result;
}
function include(name) {
  if (Object.hasOwn(schemas, name)) return;
  if (!source[name]) throw new Error(`Missing schema: ${name}`);
  schemas[name] = null; // Mark before recursion.
  schemas[name] = project(source[name]);
}
// Wallet response families only; recursively retain their referenced types.
for (const name of Object.keys(source)
  .filter((name) => name.startsWith("Wallet"))
  .sort())
  include(name);
const sorted = Object.fromEntries(
  Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(
  new URL("../lib/dmnd/validation.generated.json", import.meta.url),
  JSON.stringify(sorted) + "\n",
);
console.log(
  `Generated structural validation schemas: ${Object.keys(sorted).length}`,
);

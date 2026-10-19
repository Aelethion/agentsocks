import type { ZodRawShape, ZodTypeAny } from "zod";

interface Check {
  kind: string;
  value?: unknown;
  inclusive?: boolean;
  regex?: RegExp;
  message?: string;
}

interface Bound {
  value: number;
  message?: string;
}

interface Def {
  typeName: string;
  checks?: Check[];
  values?: unknown;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  minLength?: Bound | null;
  maxLength?: Bound | null;
  exactLength?: Bound | null;
  defaultValue?: () => unknown;
  description?: string;
}

const unsupported = (path: string, what: string): never => {
  throw new Error(`agentsocks cannot describe ${path} to OpenCode: unsupported zod ${what}`);
};

const literal = (path: string, value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? unsupported(path, "default value (not JSON data)") : text;
};

const withMessage = (check: Check, ...args: string[]): string => `(${(check.message === undefined ? args : [...args, JSON.stringify(check.message)]).join(", ")})`;

function stringChecks(path: string, checks: Check[]): string {
  return checks
    .map((c) => {
      if (c.kind === "min" || c.kind === "max" || c.kind === "length") return `.${c.kind}${withMessage(c, literal(path, c.value))}`;
      if (c.kind === "regex" && c.regex) return `.regex${withMessage(c, `new RegExp(${JSON.stringify(c.regex.source)}, ${JSON.stringify(c.regex.flags)})`)}`;
      return unsupported(path, `string check ${c.kind}`);
    })
    .join("");
}

function numberChecks(path: string, checks: Check[]): string {
  return checks
    .map((c) => {
      if (c.kind === "int") return `.int${withMessage(c)}`;
      if ((c.kind === "min" || c.kind === "max") && c.inclusive) return `.${c.kind}${withMessage(c, literal(path, c.value))}`;
      return unsupported(path, `number check ${c.kind}${c.inclusive === false ? " (exclusive)" : ""}`);
    })
    .join("");
}

const defOf = (schema: ZodTypeAny): Def => schema._def as Def;

function describedAs(schema: ZodTypeAny): string | undefined {
  for (let node: ZodTypeAny | undefined = schema; node; node = defOf(node).innerType) {
    const text = defOf(node).description;
    if (text !== undefined) return text;
  }
  return undefined;
}

const ARRAY_BOUNDS = [
  ["min", "minLength"],
  ["max", "maxLength"],
  ["length", "exactLength"],
] as const;

function arrayBounds(path: string, def: Def): string {
  return ARRAY_BOUNDS.map(([method, key]) => {
    const bound = def[key];
    return bound ? `.${method}(${[literal(path, bound.value), ...(bound.message === undefined ? [] : [JSON.stringify(bound.message)])].join(", ")})` : "";
  }).join("");
}

const described = (schema: ZodTypeAny, source: string): string => {
  const description = describedAs(schema);
  return description === undefined ? source : `${source}.describe(${JSON.stringify(description)})`;
};

function body(path: string, schema: ZodTypeAny, zod: string): string {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodString":
      return `${zod}.string()${stringChecks(path, def.checks ?? [])}`;
    case "ZodNumber":
      return `${zod}.number()${numberChecks(path, def.checks ?? [])}`;
    case "ZodBoolean":
      return `${zod}.boolean()`;
    case "ZodEnum":
      return `${zod}.enum(${literal(path, def.values)})`;
    case "ZodArray":
      return `${zod}.array(${described(def.type!, body(`${path}[]`, def.type!, zod))})${arrayBounds(path, def)}`;
    case "ZodOptional":
      return `${body(path, def.innerType!, zod)}.optional()`;
    case "ZodDefault":
      return `${body(path, def.innerType!, zod)}.default(${literal(path, def.defaultValue?.())})`;
    default:
      return unsupported(path, `type ${def.typeName}`);
  }
}

export function zodSource(shape: ZodRawShape, zod = "tool.schema"): string {
  const fields = Object.entries(shape).map(([key, schema]) => `  ${JSON.stringify(key)}: ${described(schema, body(key, schema, zod))},`);
  return fields.length === 0 ? "{}" : `{\n${fields.join("\n")}\n}`;
}

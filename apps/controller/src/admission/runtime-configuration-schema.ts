import { readFileSync } from "node:fs";

import {
  configurationSettingMessage,
  environmentReferenceNames,
  keyedSettingPath,
  type ConfigurationValueProblem,
  type ConfigurationValuesCheck,
} from "@openclaw-enterprise/occ";

/**
 * The configuration JSON Schema and UI hints of the OpenClaw runtime this controller's source
 * pins (`deploy/runtime/openclaw-source.json`). `scripts/generate-runtime-config-schema.ts`
 * regenerates the file from the runtime image and records the commit it describes.
 */
const SCHEMA_FILE = new URL(
  "../../../../deploy/runtime/openclaw-config-schema.json",
  import.meta.url,
);

export interface RuntimeConfigurationSchema {
  /** The OpenClaw source commit the schema and hints describe. */
  readonly commit: string;
  /** What `openclaw config schema` prints at that commit: JSON Schema draft-07. */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * The display metadata the OpenClaw Control UI reads, keyed by dotted setting path with `*` for
   * any map key and `[]` for any list entry.
   */
  readonly uiHints: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

let cached: RuntimeConfigurationSchema | undefined;

/** Reads the bundled file once; later calls return the same parsed document. */
export function loadRuntimeConfigurationSchema(): RuntimeConfigurationSchema {
  if (cached === undefined) {
    const { openclaw, schema, uiHints } = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
      openclaw: { commit: string };
      schema: RuntimeConfigurationSchema["schema"];
      uiHints: RuntimeConfigurationSchema["uiHints"];
    };
    cached = Object.freeze({ commit: openclaw.commit, schema, uiHints });
  }
  return cached;
}

type JsonSchema = Readonly<Record<string, unknown>> | boolean;

// A document of the largest accepted size can hold more unknown keys than a response can list.
const PROBLEM_LIMIT = 100;

const TYPE_WORDS: Readonly<Record<string, string>> = {
  object: "an object",
  array: "a list",
  string: "a string",
  boolean: "a boolean",
  integer: "a whole number",
  number: "a number",
  null: "null",
};

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The value's JSON type in words. Whole and fractional numbers are both "a number".
function typeOf(value: unknown): string {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return TYPE_WORDS[type] ?? type;
}

const TYPE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  integer: Number.isInteger,
  number: (value) => typeof value === "number" && Number.isFinite(value),
  object: isObject,
  array: Array.isArray,
  null: (value) => value === null,
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
};

// A type word this check does not know is the runtime's to enforce.
function matchesType(value: unknown, type: string): boolean {
  return Object.hasOwn(TYPE_CHECKS, type) ? TYPE_CHECKS[type]!(value) : true;
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function declaredTypes(schema: Readonly<Record<string, unknown>>): string[] | undefined {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  return Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

// The types a union admits, through nested unions, for the wording of a type refusal.
function acceptedTypes(schema: JsonSchema): string[] {
  if (!isObject(schema)) {
    return [];
  }
  return (
    declaredTypes(schema) ??
    [schema.anyOf, schema.oneOf].flatMap((branches) =>
      Array.isArray(branches) ? (branches as JsonSchema[]).flatMap(acceptedTypes) : [],
    )
  );
}

// The fixed values a `const` or `enum` schema admits; none for another schema.
function fixedChoices(schema: JsonSchema): readonly unknown[] {
  if (!isObject(schema)) {
    return [];
  }
  if ("const" in schema) {
    return [schema.const];
  }
  return Array.isArray(schema.enum) ? schema.enum : [];
}

function typeWords(types: readonly string[]): string {
  return [...new Set(types)].map((type) => TYPE_WORDS[type] ?? type).join(" or ");
}

class Walk {
  readonly problems: ConfigurationValueProblem[] = [];
  // The path of the value under check. A walk of a union branch shares its parent's array: each
  // push is popped before the walk returns.
  private readonly segments: (string | number)[];

  constructor(segments: (string | number)[] = []) {
    this.segments = segments;
  }

  private pointer(): string {
    return this.segments
      .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
      .join("");
  }

  // gateway.port, agents.entries.main, models.providers["openai/eu"].models[0]
  private setting(): string {
    let name = "";
    for (const segment of this.segments) {
      name =
        typeof segment === "number"
          ? `${name}[${segment}]`
          : keyedSettingPath(name, segment).replace(/^\./u, "");
    }
    return name === "" ? "(the whole document)" : name;
  }

  private report(code: ConfigurationValueProblem["code"], requirement: string): void {
    if (this.problems.length < PROBLEM_LIMIT) {
      this.problems.push({
        path: this.pointer(),
        code,
        message: configurationSettingMessage(this.setting(), requirement),
      });
    }
  }

  private child(segment: string | number, schema: JsonSchema, value: unknown): void {
    this.segments.push(segment);
    this.check(schema, value);
    this.segments.pop();
  }

  check(schema: JsonSchema, value: unknown): void {
    // A `$ref` points into the `$defs` of an embedded plugin schema. The runtime resolves it;
    // this check accepts the value. A walk that already holds every problem it can report stops,
    // so a large refused document costs no more than a large accepted one.
    if (
      !isObject(schema) ||
      typeof schema.$ref === "string" ||
      this.problems.length >= PROBLEM_LIMIT
    ) {
      return;
    }
    const types = declaredTypes(schema);
    if (types !== undefined && !types.some((type) => matchesType(value, type))) {
      this.report("INVALID_TYPE", `must be ${typeWords(types)}, not ${typeOf(value)}`);
      return;
    }
    // The runtime replaces `${NAME}` references before it validates, so the text that will
    // stand there is unknown: such a string is checked for its type only.
    const choices = fixedChoices(schema);
    if (
      choices.length > 0 &&
      !choices.some((choice) => sameJson(choice, value)) &&
      !(typeof value === "string" && environmentReferenceNames(value).length > 0)
    ) {
      this.reportChoices(choices);
      return;
    }
    if (typeof value === "number") {
      this.checkRange(schema, value);
    }
    const { anyOf, oneOf } = schema;
    if (
      (Array.isArray(anyOf) && anyOf.length > 0 && !this.checkUnion(anyOf, value)) ||
      (Array.isArray(oneOf) && oneOf.length > 0 && !this.checkUnion(oneOf, value))
    ) {
      return;
    }
    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf as JsonSchema[]) {
        this.check(part, value);
      }
    }
    if (isObject(value)) {
      this.checkObject(schema, value);
    } else if (Array.isArray(value)) {
      this.checkArray(schema, value);
    }
  }

  private checkRange(schema: Readonly<Record<string, unknown>>, value: number): void {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
    if (typeof minimum === "number" && value < minimum) {
      this.report("INVALID_RANGE", `must be at least ${minimum}`);
    } else if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      this.report("INVALID_RANGE", `must be greater than ${exclusiveMinimum}`);
    } else if (typeof maximum === "number" && value > maximum) {
      this.report("INVALID_RANGE", `must be at most ${maximum}`);
    } else if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      this.report("INVALID_RANGE", `must be less than ${exclusiveMaximum}`);
    }
  }

  // Accepts a value that one branch accepts. Otherwise reports the problems of the branch with
  // the fewest among those whose type fits, so a misspelled key inside a union names the key.
  // When those branches only list fixed values, the refusal lists the values of all of them.
  private checkUnion(branches: readonly JsonSchema[], value: unknown): boolean {
    const here = this.pointer();
    let closest: readonly ConfigurationValueProblem[] | undefined;
    let fixedValues = true;
    for (const branch of branches) {
      // Most branches differ by type: skip one the value's type rules out without walking it.
      const types = isObject(branch) ? declaredTypes(branch) : undefined;
      if (types !== undefined && !types.some((type) => matchesType(value, type))) {
        continue;
      }
      const walk = new Walk(this.segments);
      walk.check(branch, value);
      const [first] = walk.problems;
      if (first === undefined) {
        return true;
      }
      const atValue = walk.problems.length === 1 && first.path === here;
      if (atValue && first.code === "INVALID_TYPE") {
        continue;
      }
      fixedValues &&= atValue && first.code === "INVALID_VALUE";
      if (closest === undefined || walk.problems.length < closest.length) {
        closest = walk.problems;
      }
    }
    if (closest === undefined) {
      const words = typeWords(branches.flatMap(acceptedTypes));
      this.report(
        "INVALID_TYPE",
        words === ""
          ? "does not have a type that the pinned OpenClaw runtime accepts here"
          : `must be ${words}, not ${typeOf(value)}`,
      );
    } else if (fixedValues) {
      this.reportChoices(branches.flatMap(fixedChoices));
    } else {
      for (const problem of closest) {
        if (this.problems.length < PROBLEM_LIMIT) {
          this.problems.push(problem);
        }
      }
    }
    return false;
  }

  private reportChoices(choices: readonly unknown[]): void {
    const shown = choices.map((choice) => JSON.stringify(choice));
    this.report(
      "INVALID_VALUE",
      shown.length === 1
        ? `must be ${shown[0]}`
        : `must be one of ${shown.slice(0, 12).join(", ")}${shown.length > 12 ? ", ..." : ""}`,
    );
  }

  private checkObject(
    schema: Readonly<Record<string, unknown>>,
    value: Readonly<Record<string, unknown>>,
  ): void {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const patterns = isObject(schema.patternProperties)
      ? Object.entries(schema.patternProperties).map(
          ([pattern, entry]) => [new RegExp(pattern, "u"), entry as JsonSchema] as const,
        )
      : [];
    const additional = schema.additionalProperties as JsonSchema | undefined;
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        this.child(key, properties[key] as JsonSchema, entry);
        continue;
      }
      const matching = patterns.filter(([pattern]) => pattern.test(key));
      for (const [, entrySchema] of matching) {
        this.child(key, entrySchema, entry);
      }
      if (matching.length > 0) {
        continue;
      }
      if (additional === false) {
        this.segments.push(key);
        this.report("UNKNOWN_FIELD", "is not a setting of the pinned OpenClaw runtime");
        this.segments.pop();
      } else if (additional !== undefined) {
        this.child(key, additional, entry);
      }
    }
  }

  private checkArray(schema: Readonly<Record<string, unknown>>, value: readonly unknown[]): void {
    const items = schema.items as JsonSchema | readonly JsonSchema[] | undefined;
    for (const [index, entry] of value.entries()) {
      const entrySchema = Array.isArray(items)
        ? index < items.length
          ? (items[index] as JsonSchema)
          : (schema.additionalItems as JsonSchema | undefined)
        : (items as JsonSchema | undefined);
      if (entrySchema === false) {
        this.segments.push(index);
        this.report("UNKNOWN_FIELD", "is one entry more than the pinned OpenClaw runtime accepts");
        this.segments.pop();
      } else if (entrySchema !== undefined) {
        this.child(index, entrySchema, entry);
      }
    }
  }
}

/**
 * What the pinned runtime's configuration schema refuses in Configuration `values`: a key that a
 * closed object does not list, a wrong type, a value outside `const` or `enum`, and a number
 * outside its bounds, through unions, maps and lists. A union accepts a value that any branch
 * accepts.
 *
 * The stored document is not the document the runtime validates, so the check leaves the rest to
 * the runtime. The runtime fills defaults and OCC sets some settings at deployment, so `required`
 * is not checked. The runtime replaces `${NAME}` references first, so string patterns, formats
 * and lengths are not checked, and a string that holds a reference skips `const` and `enum`.
 * `not`, `if` and `$ref` are not evaluated.
 */
export function runtimeConfigurationProblems(
  schema: JsonSchema,
  values: unknown,
): readonly ConfigurationValueProblem[] {
  const walk = new Walk();
  walk.check(schema, values);
  return walk.problems;
}

/** The check the API passes to OCC with every write of Configuration values. */
export const checkRuntimeConfigurationValues: ConfigurationValuesCheck = (values) =>
  runtimeConfigurationProblems(loadRuntimeConfigurationSchema().schema, values);

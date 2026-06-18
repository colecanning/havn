import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { Recipe } from "./schema.js";

/** Parse + validate a recipe YAML file. Throws a readable error on malformed input. */
export function loadRecipe(path: string): Recipe {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read/parse recipe YAML at ${abs}: ${(err as Error).message}`);
  }
  const result = Recipe.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid recipe at ${abs}:\n${issues}`);
  }
  return result.data;
}

/** Validate an already-parsed object as a recipe (used in tests). */
export function parseRecipe(raw: unknown): Recipe {
  return Recipe.parse(raw);
}

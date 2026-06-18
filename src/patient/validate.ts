import type { Patient } from "./schema.js";
import type { Recipe } from "../recipe/schema.js";
import type { NeedsItem } from "../core/types.js";
import { hasValueAtPath } from "../util/path.js";

/**
 * Missing-info handling. Diff the patient record against the recipe's required
 * fields (across all *mapped* steps) and return a structured "needs" list. The
 * caller uses this to gather missing data BEFORE the runner starts — we never
 * begin a partial submission.
 *
 * Unmapped steps contribute no requirements yet (their fields are empty); once
 * mapping fills them in, their required fields are automatically enforced here.
 */
export function collectNeeds(patient: Patient, recipe: Recipe): NeedsItem[] {
  const needs: NeedsItem[] = [];
  for (const step of recipe.steps) {
    for (const field of step.fields) {
      if (!field.required) continue;
      if (!hasValueAtPath(patient, field.key)) {
        needs.push({ key: field.key, step: step.id, type: field.type, reason: "missing" });
      }
    }
  }
  return needs;
}

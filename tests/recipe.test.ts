import { describe, it, expect } from "vitest";
import { loadRecipe, parseRecipe } from "../src/recipe/load.js";

describe("recipe loading", () => {
  it("loads and validates the checked-in skyrizi recipe", () => {
    const recipe = loadRecipe("recipes/skyrizi.yaml");
    expect(recipe.drug).toBe("skyrizi");
    expect(recipe.manufacturer).toBe("abbvie");
    expect(recipe.eligibility.required_insurance).toBe("commercial");
    // gate_step must reference a real step
    expect(recipe.steps.some((s) => s.id === recipe.eligibility.gate_step)).toBe(true);
  });

  it("has a fully-mapped Step 1 with the four diagnosis options", () => {
    const recipe = loadRecipe("recipes/skyrizi.yaml");
    const account = recipe.steps.find((s) => s.id === "account");
    expect(account?.mapped).toBe(true);
    const diagnosis = account?.fields.find((f) => f.key === "diagnosis");
    expect(diagnosis?.type).toBe("radio");
    expect(Object.keys(diagnosis?.label_map ?? {})).toHaveLength(4);
  });

  it("rejects a malformed recipe with readable issues", () => {
    expect(() => parseRecipe({ drug: "x" })).toThrow();
  });

  it("rejects a radio field with no label_map", () => {
    expect(() =>
      parseRecipe({
        drug: "d",
        manufacturer: "m",
        url: "https://example.com",
        form_type: "custom_component_spa",
        eligibility: { required_insurance: "commercial", gate_step: "s1" },
        steps: [
          {
            id: "s1",
            fields: [{ key: "x", type: "radio" }],
          },
        ],
        success_signal: { type: "url_redirect", match: "/done" },
      }),
    ).toThrow();
  });
});

import type { DriverName } from "../core/types.js";
import type { DriverContext, EnrollDriver } from "./types.js";
import { PlaywrightDriver } from "./playwright.js";

/** Construct the requested enrollment backend. */
export function makeDriver(name: DriverName, ctx: DriverContext): EnrollDriver {
  switch (name) {
    case "playwright":
      return new PlaywrightDriver(ctx);
    case "os":
      // Phase 2 — the no-CDP OS-input driver. Gated on the validation spike.
      throw new Error(
        'The "os" (no-CDP) driver is not implemented yet. ' +
          "Run the Phase 0 validation spike first (see the plan), then build it.",
      );
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown driver: ${String(exhaustive)}`);
    }
  }
}

export type { EnrollDriver, DriverContext } from "./types.js";

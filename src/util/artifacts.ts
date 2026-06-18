import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Ensure and return the per-run artifact directory. Artifacts (screenshots,
 * confirmation records, mapping reports) may contain PII or live-form snapshots,
 * so this directory is gitignored and must be treated as sensitive.
 */
export function runDir(artifactDir: string, runId: string): string {
  const dir = resolve(artifactDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

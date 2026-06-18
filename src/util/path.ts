/**
 * Read a value from an object by a dotted path, e.g. getByPath(p, "address.line1").
 * Returns undefined if any segment is missing. Used to resolve a recipe field's
 * `key` against the patient record.
 */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc != null && typeof acc === "object" && segment in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, obj);
}

/** True when a path resolves to a non-empty value (not undefined/null/""). */
export function hasValueAtPath(obj: unknown, path: string): boolean {
  const v = getByPath(obj, path);
  return v !== undefined && v !== null && v !== "";
}

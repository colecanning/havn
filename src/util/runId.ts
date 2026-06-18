/** A stable, sortable run id like "skyrizi-20260618-1718712345". */
export function makeRunId(prefix = "run"): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const secs = Math.floor(now.getTime() / 1000);
  return `${prefix}-${date}-${secs}`;
}

/**
 * Build a Gmail "+alias" address from a base inbox so every test enrollment lands
 * in one inbox you can check, while each run still gets a unique address.
 *
 *   testEmail("skyrizi-1718000000", "ccanning10@gmail.com")
 *     -> "ccanning10+skyrizi-1718000000@gmail.com"
 *
 * Capturing the resulting card *from* that inbox is out of scope for v1.
 */
export function testEmail(runId: string, base = "ccanning10@gmail.com"): string {
  const at = base.indexOf("@");
  if (at < 1) throw new Error(`Invalid base email: ${base}`);
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  // Strip characters Gmail would reject inside the alias.
  const alias = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${local}+${alias}@${domain}`;
}

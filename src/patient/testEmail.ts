/**
 * Build a per-run test email that still lands in one inbox you can check.
 *
 * NOTE: this form's email validator REJECTS the "+" character, so Gmail plus-aliasing
 * (ccanning10+id@gmail.com) does NOT work here. Instead we use Gmail's dot trick:
 * Gmail ignores dots in the local part, so c.canning10@gmail.com, cc.anning10@gmail.com,
 * etc. all deliver to ccanning10@gmail.com. We insert ONLY dots (never other
 * characters — that would change the mailbox) at positions derived from the run id,
 * giving a stable, unique-ish address per run that the form accepts.
 *
 * "ccanning10" has 9 inter-character gaps -> up to 2^9 = 512 distinct addresses.
 */

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function testEmail(runId: string, base = "ccanning10@gmail.com"): string {
  const at = base.indexOf("@");
  if (at < 1) throw new Error(`Invalid base email: ${base}`);
  const local = base.slice(0, at).replace(/\./g, ""); // normalize to the canonical mailbox
  const domain = base.slice(at + 1);
  if (local.length < 2) return `${local}@${domain}`;

  const h = hash32(runId);
  const chars = local.split("");
  let out = chars[0] as string;
  for (let i = 1; i < chars.length; i++) {
    // One optional dot per gap (never leading/trailing/consecutive).
    if ((h >> ((i - 1) % 31)) & 1) out += ".";
    out += chars[i] as string;
  }
  return `${out}@${domain}`;
}

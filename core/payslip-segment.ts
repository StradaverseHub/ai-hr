/**
 * 3c88d593 — the entity SEGMENT a payslip covers, read from the payslip's own snapshot.
 *
 * PURE AND DB-FREE, deliberately: the screen, the PDF and (in stage two) any report that prints a
 * segmented month must all apply ONE rule about what the stamp means, and none of them should be able to
 * re-derive a closed payslip's period from today's assignment history — which a later correction could
 * change underneath an already-issued document.
 *
 * ABSENT ⇒ NULL ⇒ the whole pay period, which is every payslip this system has ever produced except the
 * ones written for a month containing an entity transfer. A caller that gets null prints exactly what it
 * printed before this item existed.
 */

/** The inclusive range of the pay period this slip's employer actually employed the person for. */
export type PayslipSegment = { companyId: string; from: string; to: string };

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The segment stamped by core/payroll.ts, or null when the month was not split.
 *
 * Defensive about the blob's shape rather than trusting it: `payslip.statutory` is plain jsonb spanning
 * every payslip ever written, so a reader that assumes a field's type is one bad row away from throwing
 * on a screen. A malformed stamp reads as "no segment", which degrades to the pre-item rendering.
 */
export function payslipSegment(statutory: unknown): PayslipSegment | null {
  if (!statutory || typeof statutory !== 'object') return null;
  const seg = (statutory as Record<string, unknown>).segment;
  if (!seg || typeof seg !== 'object') return null;
  const { companyId, from, to } = seg as Record<string, unknown>;
  if (typeof companyId !== 'string' || !isDate(from) || !isDate(to)) return null;
  if (from > to) return null;
  return { companyId, from, to };
}

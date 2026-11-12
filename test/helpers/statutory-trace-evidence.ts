/**
 * Item 69d6ed3c — statutory trace v1 is DISPLAY EVIDENCE stamped on every newly processed payslip
 * (`statutory.statutoryTrace`): which pay items made up each wage, the schedule row each wage fell in and the
 * amounts that row gives. It moves no money. The money-parity pins below compare everything else byte for byte
 * against goldens captured before the trace existed, so they first prove the trace agrees with the payslip it
 * sits on — `explainStatutory` refuses one whose amounts differ from the payslip's — and then set it aside.
 *
 * Setting it aside is the same move those files already make for `componentLines` / `hrdfWorking` provenance.
 * It is NOT "ignore any new key": the trace must be present and must reconcile, or this throws.
 */
import { expect } from 'vitest';
import { explainStatutory } from '../../core/statutory-explain';

export function withoutVerifiedStatutoryTrace<T>(statutory: T): T {
  const st = statutory as Record<string, unknown>;
  expect(st.statutoryTrace, 'every newly processed payslip stamps statutory trace v1').toBeDefined();
  expect(explainStatutory(st, 'regular').traceStatus, 'the trace reconciles with this payslip’s own amounts').toBe('recorded');
  const rest = { ...st };
  delete rest.statutoryTrace;
  return rest as T;
}

/** A canonical run document's payslips with each verified trace set aside (the shape both hash pins build). */
export function withoutVerifiedTraces<D>(doc: D): D {
  const d = doc as { payslips: { statutory: unknown }[] } & Record<string, unknown>;
  return { ...d, payslips: d.payslips.map((p) => ({ ...p, statutory: withoutVerifiedStatutoryTrace(p.statutory) })) } as D;
}

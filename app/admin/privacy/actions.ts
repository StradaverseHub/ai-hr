'use server';

import { requireAdmin } from '@/lib/authz';
import { erasePersonPii, type ErasureReport, type ErasureScope } from '@/core/pdpa';

const SCOPES: ErasureScope[] = ['contact', 'financial', 'identity', 'statutory-ids', 'all'];

export type ErasureActionResult = { ok: true; report: ErasureReport } | { ok: false; error: string };

/** Run a retention-guarded PDPA erasure (ADR-0030). Admin/DPO-only. Returns the report (erased vs withheld)
 *  to the client form rather than redirecting, so the DPO sees exactly what was and wasn't destroyed. */
export async function erasePersonPiiAction(input: {
  employmentId: string;
  scope: string;
  reason: string;
  requestRef: string;
}): Promise<ErasureActionResult> {
  const s = await requireAdmin();
  const employmentId = input.employmentId.trim();
  const reason = input.reason.trim();
  const requestRef = input.requestRef.trim();
  if (!employmentId) return { ok: false, error: 'An employment id is required.' };
  if (!requestRef) return { ok: false, error: 'A DPO request reference is required for the audit trail.' };
  if (!SCOPES.includes(input.scope as ErasureScope)) return { ok: false, error: 'Invalid scope.' };
  try {
    const report = await erasePersonPii(s, { subjectEmploymentId: employmentId, scope: input.scope as ErasureScope, reason, requestRef });
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
// ADR-0080 D11 — through the PACK FACADE. The page beside this file imports core/attendance directly as
// audited kernel-contract debt (test/pack-drift-allowlist.json); a NEW file may not, and the drift ratchet
// refuses one that tries.
import {
  requestAttendanceCorrection,
  decideAttendanceCorrection,
} from '@/packs/attendance/service';

/**
 * dae7a10f — AN ADMINISTRATOR CORRECTS A DAY IN ONE ACTION, AND STILL LEAVES THE SAME TRAIL.
 *
 * The reporter asked to fix a day "without going through the approval workflow". What they should not
 * have to do is WAIT for somebody else. What nobody skips is the record, and the plan said so in those
 * words before this was approved — because a corrected clock time changes overtime, and overtime is paid.
 *
 * ⚠️ THIS IS NOT A SECOND WRITE PATH, AND THAT IS THE WHOLE DESIGN. It calls the SAME two services the
 * two-step workflow calls — request, then decide — back to back. Writing `attendance` directly would be
 * the shorter diff and the wrong one: approval re-derives the day through the time engine so corrected OT
 * flows to payroll (core/attendance.ts), and a direct write is exactly how overtime changes with no trail.
 * 570fd56e made Edit a LINK for this reason; this keeps the reason and removes only the waiting.
 *
 * THE PERMISSION BARRIER THE TICKET ASSUMES DOES NOT EXIST. `assertCanDecide` computes `isSelf` as
 * subject.personId === ctx.personId — the rule is "the decider is not the SUBJECT EMPLOYEE", not "the
 * decider is not the requester". An HR admin deciding somebody else's correction is already authorised,
 * so this needs no new authority and grants no exemption.
 *
 * SELF-CORRECTION STILL REFUSES, AND THE REQUEST SURVIVES THE REFUSAL. When an administrator is also the
 * subject, `decideAttendanceCorrection` throws and the correction stays PENDING — which is the right
 * outcome rather than an error to paper over: the correction is not lost, it simply now needs another
 * approver, exactly as it would have through the two-step screen. The refusal is surfaced; it is never
 * swallowed, because an admin silently approving their own overtime is the one thing this must not allow.
 */
export async function adminCorrectAttendanceDayAction(formData: FormData) {
  const { s, scopeIds } = await scopedAdmin();

  const employmentId = String(formData.get('employmentId') ?? '');
  const date = String(formData.get('date') ?? '');
  const checkIn = String(formData.get('checkIn') ?? '').trim();
  const checkOut = String(formData.get('checkOut') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  const back = `/attendance/individual/${encodeURIComponent(date)}?emp=${encodeURIComponent(employmentId)}`;
  const fail = (key: string): never => redirect(`${back}&error=${encodeURIComponent(key)}`);

  // ⚠️ THE EMPLOYMENT IS RE-GUARDED, never trusted from the form. A hidden input is a suggestion; the
  // caller's own scoped employee list is the gate, and it is the SAME list the screen was rendered from.
  const employees = await listEmployees(s, scopeIds);
  if (!employees.some((e) => e.employmentId === employmentId)) fail('correctionForbidden');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('correctionBadDate');

  // A correction with no reason is an unexplained change to a paid figure.
  if (!reason) fail('correctionReasonRequired');
  if (!checkIn && !checkOut) fail('correctionNothingToChange');

  let correctionId: string;
  try {
    ({ correctionId } = await requestAttendanceCorrection(s, {
      employmentId,
      date,
      checkIn: checkIn || null,
      checkOut: checkOut || null,
      reason,
      // requestKind is deliberately OMITTED, exactly as the existing clock-correction form omits it.
      // The five stored kinds (self_overtime, short_hours, incomplete_entry, absent, other) describe why
      // an EMPLOYEE raised a request; none of them describes an administrator fixing a time, and picking
      // the nearest would mislabel a payroll-affecting record. NULL is what this path has always stored.
    }));
  } catch {
    fail('correctionRejected');
  }

  try {
    await decideAttendanceCorrection(s, { correctionId: correctionId!, decision: 'approved' });
  } catch {
    // The request EXISTS and is pending — say so, rather than reporting a failure that lost the work.
    // The commonest cause by far is an administrator correcting their own day.
    redirect(`${back}&error=${encodeURIComponent('correctionPendingAnotherApprover')}`);
  }

  revalidatePath(back);
  redirect(`${back}&corrected=1`);
}

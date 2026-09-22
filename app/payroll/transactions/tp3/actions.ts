'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { employmentSubject } from '@/core/read';
// THROUGH THE PACK FACADE (ADR-0080 D9/D11) — a screen reaches payroll vocabulary through
// `packs/payroll/service`, never `core/tp3` directly. test/payroll-pack-drift.test.ts fails a new
// direct import and its allowlist only ever shrinks.
import { deleteTp3, saveTp3 } from '@/packs/payroll/service';
import { readTp3FormInput } from '@/lib/tp3-form-input';

/**
 * df35d60d — the TP3 previous-employment record's two writes.
 *
 * ⚠️ NEITHER OF THEM TOUCHES A TAX FIGURE. `core/tp3.ts` writes `employee_tp3` and nothing else; the four
 * opening-balance columns the PCB kernel seeds from stay where they are, owned by the Payroll tab's own
 * `setTp3Action`. Stage 2 is what joins them, deliberately.
 *
 * `requireAdmin` HERE AND `is_admin()` IN THE POLICY. Two gates on purpose: a server action has no layout
 * above it, so the page's guard covers a render and covers nothing posted. The service adds a third
 * (`requireAdminTarget`), because a service that trusts its caller is a service with one gate.
 *
 * THE EMPLOYMENT IS RESOLVED TO A PERSON THROUGH `employmentSubject`, which is RLS-gated: a posted
 * employmentId outside the caller's scope resolves to nothing and the write never runs. The form posts an
 * employment because that is what the screen selects; the record is keyed on the PERSON.
 */

const back = (employmentId: string, year: number, extra: string) =>
  redirect(
    `/payroll/transactions/tp3?employmentId=${encodeURIComponent(employmentId)}&year=${year}&${extra}`,
  );

export async function saveTp3Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');
  const input = readTp3FormInput(formData);
  const subject = await employmentSubject(s, employmentId);
  if (!subject) back(employmentId, input.assessmentYear, 'error=notFound');
  try {
    await saveTp3(s, {
      personId: subject.personId,
      assessmentYear: input.assessmentYear,
      deductionMonth: input.deductionMonth,
      previousEmployers: input.previousEmployers,
      sectionC: input.sectionC,
      sectionD: input.sectionD,
      declarationAccepted: input.declarationAccepted,
      remarks: input.remarks,
    });
  } catch (e) {
    back(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp3');
  back(employmentId, input.assessmentYear, 'toast=saved');
}

export async function deleteTp3Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');
  const year = Number(formData.get('assessmentYear'));
  const subject = await employmentSubject(s, employmentId);
  if (!subject) back(employmentId, year, 'error=notFound');
  try {
    await deleteTp3(s, { personId: subject.personId, assessmentYear: year });
  } catch (e) {
    back(employmentId, year, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp3');
  back(employmentId, year, 'toast=deleted');
}

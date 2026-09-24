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
 * ⚠️ THE SAVE NOW MOVES A TAX FIGURE (item 1bb09a73). `core/tp3.ts` writes `employee_tp3` AND projects
 * its Section C onto the four opening-balance columns the PCB kernel seeds from, in one transaction.
 * The Payroll tab's `setTp3Action` still edits those columns by hand afterwards.
 *
 * THE OUTCOME IS CARRIED INTO THE REDIRECT rather than dropped. `saveTp3` returns whether the projection
 * applied; when a LATER assessment year holds the columns it does not, and the operator has to be told
 * that in the same breath as "Saved" — a green toast over a form whose figures reached nothing is the
 * exact shape of the defect this item was raised about.
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
  let outcome: Awaited<ReturnType<typeof saveTp3>>['seed'] | null = null;
  try {
    ({ seed: outcome } = await saveTp3(s, {
      personId: subject.personId,
      assessmentYear: input.assessmentYear,
      deductionMonth: input.deductionMonth,
      previousEmployers: input.previousEmployers,
      sectionC: input.sectionC,
      sectionD: input.sectionD,
      declarationAccepted: input.declarationAccepted,
      remarks: input.remarks,
    }));
  } catch (e) {
    back(employmentId, input.assessmentYear, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp3');
  // `redirect` throws, so this is the only line that runs on the success path.
  back(
    employmentId,
    input.assessmentYear,
    outcome && !outcome.applied && outcome.reason === 'laterYearHoldsColumns'
      ? `toast=savedFormOnly&heldBy=${outcome.heldBy}`
      : 'toast=saved',
  );
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

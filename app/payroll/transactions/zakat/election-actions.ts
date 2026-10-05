'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  getStatutoryProfileMY,
  setStatutoryProfileMY,
  type ZakatMethod,
} from '@/localization/my/statutory';

/**
 * Zakat election relocation (feedback 58755260). The durable per-employee zakat election (state,
 * method, %-of-PCB or fixed RM, effective dates) is now edited HERE — Payroll > Transaction Entry > Zakat —
 * in an employee-first flow; the Personnel > Statutory (MY) form no longer carries zakat fields.
 *
 * This action delegates to the EXISTING setStatutoryProfileMY setter, which validates the election
 * (InvalidZakatSetupError) and appends the existing statutory.my.updated/created domain event with the
 * zakat fields in the payload — so no new event type and no extra append here (substrate discipline:
 * the write is fully covered inside the setter).
 *
 * setStatutoryProfileMY is a FULL overwrite of the statutory row, so we read the current profile and
 * pass every non-zakat field through unchanged (numeric columns come back as strings; the setter
 * re-normalises). Only the 7 zakat fields come from the form.
 */
export async function saveZakatElectionAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const personId = String(formData.get('personId'));
  // Redirect back to the same employee's records (the one-off override section was removed by d435673e, so
  // there is no sibling selection to preserve any more).
  //
  // 6a1f2bd6 — SUCCESS AND FAILURE NOW LAND IN DIFFERENT PLACES, and that is the point. The editor moved
  // off the list onto its own page, so a save that WORKED should return the reader to the list they came
  // from, while one the setter REFUSED (InvalidZakatSetupError: percent method with no percentage, and so
  // on) has to land back on the form the message is about. Bouncing a refusal to the list would print a red
  // banner on a screen that no longer contains a single one of the fields it names.
  const back = (extra: string) =>
    `/payroll/transactions/zakat?employmentId=${encodeURIComponent(employmentId)}&${extra}`;
  const backToForm = (extra: string) =>
    `/payroll/transactions/zakat/election?employmentId=${encodeURIComponent(employmentId)}&${extra}`;
  try {
    const current = await getStatutoryProfileMY(s, personId);
    // The election lives on the MY statutory row; without one (no IC yet) there is nothing to attach it
    // to. The page hides the form in that state, so this guard only fires for stale/forged submissions.
    if (!current)
      throw new Error(
        'No Malaysian statutory profile for this employee yet — save the IC number on the personnel record first.',
      );
    const num = (v: string | null): number | null =>
      v == null || Number.isNaN(Number(v)) ? null : Number(v);
    await setStatutoryProfileMY(s, {
      personId,
      // Read-modify-write pass-through: every non-zakat field is preserved verbatim so an
      // election-only save can never clobber IC/EPF/SOCSO/tax/TP3/bank data. Item e3ce0d4d — icNumber is now
      // nullable (non-Malaysian passport identity). Item 35524d1f — the '' coercion that used to sit here made
      // the setter reject the save outright for a passport-identified employee, so the null passes through.
      icNumber: current.icNumber,
      epfNumber: current.epfNumber ?? undefined,
      socsoNumber: current.socsoNumber ?? undefined,
      taxNumber: current.taxNumber ?? undefined,
      taxCategory: current.taxCategory,
      numChildren: current.numChildren,
      eisEligible: current.eisEligible,
      // Item a7271737 — preserve the SOCSO/EIS category on this read-modify-write so an election-only save can
      // never reset it to 'auto'. Passing the stored category also keeps the derived subject_to_socso /
      // eis_eligible booleans intact (the setter derives them from the category when it is supplied).
      socsoCategory: current.socsoCategory,
      eisCategory: current.eisCategory,
      // Item 5a461b99 — preserve the remaining SOCSO/EIS control flags too. setStatutoryProfileMY defaults
      // each unspecified flag to false, so omitting them here would silently reset an HR-set "Subject to
      // SKBBK" / "Employer bears X" configuration on an election-only save.
      subjectToSkbbk: current.subjectToSkbbk,
      employerBearsSocso: current.employerBearsSocso,
      employerBearsEis: current.employerBearsEis,
      employerBearsSkbbk: current.employerBearsSkbbk,
      isResident: current.isResident,
      epfCitizenship: current.epfCitizenship,
      epfMode: current.epfMode,
      epfEmployeeRate: num(current.epfEmployeeRate),
      epfEmployerRate: num(current.epfEmployerRate),
      // Item 70b14723 — AND THE TYPED EPF AMOUNTS + REASON, or this election-only save is a wrong payslip
      // twice over. `setStatutoryProfileMY` is a FULL-ROW OVERWRITE, so omitting them would (a) null an
      // employee's standing manual EPF figure, silently putting them back on the Third Schedule from the next
      // payroll run, and (b) fail outright before it got there — `resolveEpfElection` REFUSES a
      // 'manual_amount' row with no amount and no reason, so a zakat save would throw for exactly the
      // employees this round exists for. Same trap the SOCSO/EIS/TP3/bank pass-throughs above guard against.
      epfEmployeeAmount: num(current.epfEmployeeAmount),
      epfEmployerAmount: num(current.epfEmployerAmount),
      epfManualReason: current.epfManualReason,
      bankName: current.bankName ?? undefined,
      bankAccountNo: current.bankAccountNo ?? undefined,
      tp3Year: current.tp3Year,
      tp3NetRemuneration: num(current.tp3NetRemuneration),
      tp3EpfClaimed: num(current.tp3EpfClaimed),
      tp3PcbPaid: num(current.tp3PcbPaid),
      tp3ZakatPaid: num(current.tp3ZakatPaid),
      // The 7 zakat fields from the form. Coercion mirrors the retired Personnel block: the percent is
      // entered as a % and stored as a decimal (÷100); empty → null; the setter validates the method and
      // nulls the off-method amount.
      zakatActive: formData.get('zakatActive') === 'on',
      zakatState: (formData.get('zakatState') as string) || null,
      zakatMethod: (() => {
        const m = String(formData.get('zakatMethod') ?? '');
        return m === 'percent_of_pcb' || m === 'fixed' ? (m as ZakatMethod) : null;
      })(),
      zakatPercent: formData.get('zakatPercent') ? Number(formData.get('zakatPercent')) / 100 : null,
      zakatFixed: formData.get('zakatFixed') ? Number(formData.get('zakatFixed')) : null,
      zakatEffectiveFrom: (formData.get('zakatEffectiveFrom') as string) || null,
      zakatEffectiveTo: (formData.get('zakatEffectiveTo') as string) || null,
    });
  } catch (e) {
    redirect(backToForm(`error=${encodeURIComponent(publicErrorMessage(e))}`));
  }
  revalidatePath('/payroll/transactions/zakat');
  redirect(back('toast=saved'));
}

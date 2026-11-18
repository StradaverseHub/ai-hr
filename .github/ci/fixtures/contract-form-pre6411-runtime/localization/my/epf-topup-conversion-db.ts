/**
 * b6dbadc5 — the database side of the one-off Top-up conversion (the arithmetic and its reasoning are in
 * ./epf-topup-conversion.ts). Candidates are `voluntary_excess` rows with an employer rate — the stored
 * pre-additive Top-up elections, including employer-only ones. Employee-only rows (Semi-Auto) and rows with
 * no rates are not candidates and are never touched.
 *
 * Read-only unless `apply`. Each write goes through `setStatutoryProfileMY`, the existing full-row statutory
 * writer, with every other column carried from the locked row exactly as the Bank & Statutory import writer
 * carries them, so the `statutory.my.updated` event records the EPF election before/after and nothing else
 * on the row moves. Idempotent: a converted row is `topup_percentage` and no longer a candidate, and a row
 * whose stored rates changed between the read and the write is reported, not converted.
 *
 * The statutory row is current-state (there is no effective-dated history table for it); the event log's
 * occurredAt is the effective record of when the election changed. Payslips already generated keep their
 * figures; the new mode applies to payroll calculated after the conversion.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { compensation, employeeStatutoryMy, employment, payrollBatch, payslip, person } from '../../db/schema';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { getStatutoryProfileMYTx, setStatutoryProfileMY } from './statutory';
import { epfAgeOn, payPeriodEnd, planLegacyTopupConversion, type LegacyTopupBasis, type LegacyTopupReportRow } from './epf-topup-conversion';
import type { EpfCitizenship } from './payroll';

const rate = (v: string | number | null | undefined) => (v == null || v === '' ? null : Number(v));
const money = (v: unknown) => (v != null ? Number(v) : null);

export async function convertLegacyEpfTopupsMY(ctx: SessionContext, p: { apply?: boolean; today?: string } = {}) {
  const apply = p.apply === true;
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    // The statutory writer takes the statutory write lock itself on each write; each row is re-read under
    // FOR UPDATE before it is converted, so a row changed after this read is reported, not overwritten.
    const candidates = await tx
      .select({
        personId: employeeStatutoryMy.personId,
        epfEmployeeRate: employeeStatutoryMy.epfEmployeeRate,
        epfEmployerRate: employeeStatutoryMy.epfEmployerRate,
        epfCitizenship: employeeStatutoryMy.epfCitizenship,
      })
      .from(employeeStatutoryMy)
      .where(and(eq(employeeStatutoryMy.tenantId, ctx.tenantId), eq(employeeStatutoryMy.epfMode, 'voluntary_excess'), isNotNull(employeeStatutoryMy.epfEmployerRate)))
      .orderBy(asc(employeeStatutoryMy.personId));
    const rows: LegacyTopupReportRow[] = [];
    for (const c of candidates) {
      const [who] = await tx.select({ name: person.fullName, dob: person.dateOfBirth }).from(person).where(eq(person.id, c.personId));
      const jobs = await tx
        .select({ id: employment.id, code: employment.employeeCode })
        .from(employment)
        .where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.personId, c.personId)))
        .orderBy(desc(employment.hiredOn));
      const citizenship = (c.epfCitizenship ?? 'citizen') as EpfCitizenship;
      let basis: LegacyTopupBasis | null = null;
      if (jobs.length) {
        // The latest PROCESSED regular payslip (a draft run has not been charged; an additional run carries
        // only the bonus increment). Its stamped `bases` are the combined month the rule was resolved on.
        const [slip] = await tx
          .select({ payPeriod: payrollBatch.payPeriod, statutory: payslip.statutory })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(and(inArray(payslip.employmentId, jobs.map(j => j.id)), inArray(payrollBatch.status, ['processed', 'closed']), eq(payrollBatch.runType, 'regular')))
          .orderBy(desc(payrollBatch.payPeriod), desc(payrollBatch.runSeq), desc(payslip.createdAt))
          .limit(1);
        const bases = (slip?.statutory as { bases?: { epf?: number; epfAdditional?: number } } | undefined)?.bases;
        if (slip && bases && Number.isFinite(Number(bases.epf))) {
          basis = {
            source: 'payslip',
            payPeriod: slip.payPeriod,
            base: Math.round((Number(bases.epf) + Number(bases.epfAdditional ?? 0)) * 100) / 100,
            age: epfAgeOn(who?.dob, payPeriodEnd(slip.payPeriod)),
            citizenship,
          };
        } else {
          // No processed payslip with a stamped base: the rate for the current salary (basic + fixed allowance).
          const [pay] = await tx
            .select({ basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
            .from(compensation)
            .where(and(inArray(compensation.employmentId, jobs.map(j => j.id)), isNull(compensation.supersededAt), lte(compensation.validFrom, today)))
            .orderBy(desc(compensation.validFrom), desc(compensation.recordedAt))
            .limit(1);
          if (pay)
            basis = {
              source: 'current_salary',
              payPeriod: null,
              base: Math.round((Number(pay.basic) + Number(pay.allowance ?? 0)) * 100) / 100,
              age: epfAgeOn(who?.dob, today),
              citizenship,
            };
        }
      }
      const oldEmployeeRate = rate(c.epfEmployeeRate), oldEmployerRate = rate(c.epfEmployerRate);
      const plan = planLegacyTopupConversion({ employeeRate: oldEmployeeRate, employerRate: oldEmployerRate }, basis);
      const report: LegacyTopupReportRow = {
        status: plan.action === 'skip' ? 'skipped' : apply ? 'converted' : 'would_convert',
        employeeCode: jobs[0]?.code ?? null,
        name: who?.name ?? null,
        personId: c.personId,
        basis,
        oldEmployeeRate,
        oldEmployerRate,
        plan,
      };
      if (apply && plan.action === 'convert') {
        const row = await getStatutoryProfileMYTx(tx, ctx, c.personId, { forUpdate: true });
        if (!row || row.epfMode !== 'voluntary_excess' || rate(row.epfEmployeeRate) !== oldEmployeeRate || rate(row.epfEmployerRate) !== oldEmployerRate) {
          report.status = 'changed_since_read';
        } else {
          // The full-row writer, every other column carried from the locked row (the same carry list as
          // core/bank-statutory-import.ts applyBankStatutoryPatchTx).
          await setStatutoryProfileMY(ctx, {
            personId: c.personId,
            icNumber: row.icNumber, epfNumber: row.epfNumber ?? undefined, socsoNumber: row.socsoNumber ?? undefined,
            taxNumber: row.taxNumber ?? undefined, taxCategory: row.taxCategory ?? 1, numChildren: row.numChildren ?? 0, isResident: row.isResident ?? true,
            socsoCategory: row.socsoCategory ?? 'auto', eisCategory: row.eisCategory === 'none' ? 'none' : 'auto',
            subjectToSkbbk: row.subjectToSkbbk ?? false, employerBearsSocso: row.employerBearsSocso ?? false, employerBearsEis: row.employerBearsEis ?? false,
            employerBearsSkbbk: row.employerBearsSkbbk ?? false, employerBearsEpf: row.employerBearsEpf ?? false,
            epfCitizenship: row.epfCitizenship ?? 'citizen',
            epfMode: 'topup_percentage', epfEmployeeRate: plan.employeeTopup, epfEmployerRate: plan.employerTopup,
            epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null,
            bankName: row.bankName ?? undefined, bankAccountNo: row.bankAccountNo ?? undefined,
            tp3Year: row.tp3Year ?? null, tp3NetRemuneration: money(row.tp3NetRemuneration), tp3EpfClaimed: money(row.tp3EpfClaimed),
            tp3PcbPaid: money(row.tp3PcbPaid), tp3ZakatPaid: money(row.tp3ZakatPaid),
            zakatActive: row.zakatActive ?? false, zakatState: row.zakatState ?? null, zakatMethod: row.zakatMethod ?? null,
            zakatPercent: money(row.zakatPercent), zakatFixed: money(row.zakatFixed),
            zakatEffectiveFrom: row.zakatEffectiveFrom ?? null, zakatEffectiveTo: row.zakatEffectiveTo ?? null,
          }, tx);
        }
      }
      rows.push(report);
    }
    return { apply, scanned: candidates.length, rows };
  });
}

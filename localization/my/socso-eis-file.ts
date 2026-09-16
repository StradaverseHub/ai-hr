/**
 * SOCSO + EIS COMBINED contribution textfile (PERKESO ASSIST) — the READ, and only the read.
 *
 * ⚠️ r296 — THIS MODULE NO LONGER WRITES A BYTE OF THE FILE, AND THAT IS THE POINT OF THE ROUND. Until
 * r296 it held its OWN fixed-width writer, at v2.0 of the format, while `lib/perkeso-socso-file.ts` held
 * a second one at v1.0 behind the Borang 8A review screen. Both were reachable, both emitted 278-character
 * records, and for the same employees in the same month they emitted DIFFERENT BYTES:
 *
 *     positions 201-208   this module "00000000"   ·   lib/perkeso-socso-file "        "
 *     positions 215-220   this module "010235"     ·   lib/perkeso-socso-file " 10235"
 *     positions 239-244   this module "000000"     ·   lib/perkeso-socso-file "      "  (Filler 1)
 *     end of file         this module CRLF         ·   lib/perkeso-socso-file none
 *
 * There is ONE combined SOCSO+EIS upload file at PERKESO ASSIST, so there is now one writer:
 * `buildPerkesoSocsoFile`, which is golden-tested BYTE FOR BYTE against `test/fixtures/perkeso-brg8a.txt`,
 * a BRG8A.txt the customer's previous system produced and PERKESO ACCEPTED. The difference between the
 * two layouts — the SKBBK box — now lives behind `PERKESO_SKBBK_MANDATORY_FROM`, a DATE, and is applied
 * in exactly one place for both screens.
 *
 * WHAT IS LEFT HERE IS THE READ: which payslips, which employer, which figures. That is genuinely this
 * module's own job and is NOT shared with the Borang 8A screen, because the two screens answer to
 * different report definitions (`my.socso-eis`, the combined listing; `my.borang-8a`, PERKESO's own
 * contribution schedule). They are two documents. The upload file is one artefact, and both screens now
 * hand over the same bytes for it.
 *
 * ⚠️ FIELD 6 IS THE SOCSO/EIS WAGE BASE, NOT GROSS PAY — CHANGED IN r296, AND IT CHANGES A FIGURE. This
 * read used to write `payslip.gross_pay` into the salary box while the Borang 8A path wrote
 * `statutory.bases.socsoEis`, so the two files disagreed about field 6 as well as about padding. One
 * source was required and the repository had already decided which: see `lib/borang-8a.ts`, which
 * refuses an employee whose base was never stamped rather than "falling back to gross pay, which is a
 * different number". Gross pay includes money PERKESO does not charge on (the annual bonus is excluded —
 * docs/architecture/STATUTORY-SOURCES.md §1), so it is the wrong number for a contribution return.
 *
 * Source of the layouts (both revisions), sourced 2026-06-20:
 *   v2.0 (13 Feb 2026): https://www.perkeso.gov.my/images/borang/lindung24jam/formatteksfail.pdf
 *   v1.0 (22 Jul 2022): https://www.perkeso.gov.my/images/panduan/280722_-_TEXTFILE_STRUCTURE_FOR_COMBINE_CONTRIBUTION_V1.pdf
 *
 * Filename and encoding are NOT in either specification — confirm on the first ASSIST upload.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import {
  PerkesoFileError,
  buildPerkesoSocsoFile,
  perkesoFileEmployeesFrom,
  perkesoFileTotals,
  perkesoLayoutForPeriod,
  perkesoSkbbkNotCarried,
  perkesoUploadFilename,
  type PerkesoFileLayout,
} from '../../lib/perkeso-socso-file';
import { MY_STATUTORY_VERSION } from './statutory-tables';

const digits = (v: string) => v.replace(/\D/g, '');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One employee's month, in the shape `perkesoFileEmployeesFrom` maps from. */
export type SocsoEisRow = {
  /** Member identifier — new IC (no dashes) for Malaysians, SOCSO foreign-worker no. for foreigners. */
  ic: string;
  name: string;
  /**
   * The SOCSO/EIS WAGE the contributions were worked out from (`statutory.bases.socsoEis`), in RM.
   * NULL when no run in the period stamped one — a REFUSAL, never a substitution. See the module header.
   */
  wage: number | null;
  socsoEmployer: number;
  socsoEmployee: number;
  eisEmployer: number;
  eisEmployee: number;
  /** The SKBBK / Lindung-24-Jam employee leg (RM). Reaches the file only in v2.0. */
  skbbk: number;
};

export type SocsoEisFile = {
  filename: string;
  content: string;
  /** Which revision of the format these bytes are — decided by the contribution month, not by a screen. */
  layout: PerkesoFileLayout;
  totals: {
    salaryCents: number;
    socsoCents: number;
    eisCents: number;
    records: number;
    /**
     * ⚠️ PRESENT ONLY WHEN THE FILE ACTUALLY HAS A SKBBK BOX. An absent key asserts nothing; a
     * `skbbkCents: 0` beside a v1.0 file would assert that the money does not exist, and it does — it is
     * reported as `skbbkNotCarriedCents` instead.
     */
    skbbkCents?: number;
    /** SKBBK in sen that this revision has NO BOX for and that this upload therefore does not pay. */
    skbbkNotCarriedCents?: number;
  };
};

export class SocsoEisNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocsoEisNotReadyError';
  }
}

/**
 * Build the combined SOCSO+EIS file for a company's pay period from its generated payslips. Refuses to
 * emit with a missing employer code or member IC (ADR-0010 readiness gate); `buildPerkesoSocsoFile`
 * then applies the file's own stricter refusals (a twelve-character identity, an amount that fits its
 * box, a recorded SOCSO wage) and writes the bytes.
 */
export function socsoEisFileForBatch(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<SocsoEisFile & { statutoryVersion: string }> {
  return withTenant(ctx, async (tx) => {
    const batches = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.periodKey)));
    if (batches.length === 0)
      throw new SocsoEisNotReadyError(`No payroll batch for ${p.periodKey} — generate payslips first.`);
    const batchIds = batches.map((x) => x.id);
    const [co] = await tx
      .select({ code: companyStatutoryMy.socsoEmployerCode, ssm: companyStatutoryMy.ssmRegistrationNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    if (!co?.code) {
      throw new SocsoEisNotReadyError('Company SOCSO employer code is not set (Organization → statutory identity).');
    }
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One row per employee per month: SOCSO/EIS/SKBBK are charged once for the month (an additional run
    // adds 0, ADR-0024), so summing across the period's runs yields the monthly total; the wage base sums
    // the same way.
    const byEmp = new Map<string, SocsoEisRow>();
    const versionSet = new Set<string>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number> & { version?: string; bases?: Record<string, number> };
      if (st.version) versionSet.add(st.version);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = { ic: s.ic ?? '', name: s.name, wage: null, socsoEmployer: 0, socsoEmployee: 0, eisEmployer: 0, eisEmployee: 0, skbbk: 0 };
        byEmp.set(s.employmentId, r);
      }
      r.socsoEmployer = round2(r.socsoEmployer + Number(st.socsoEmployer ?? 0));
      r.socsoEmployee = round2(r.socsoEmployee + Number(st.socsoEmployee ?? 0));
      r.eisEmployer = round2(r.eisEmployer + Number(st.eisEmployer ?? 0));
      r.eisEmployee = round2(r.eisEmployee + Number(st.eisEmployee ?? 0));
      r.skbbk = round2(r.skbbk + Number(st.socsoSkbbk ?? 0));
      // `bases.socsoEis` (r187 onward). Absent on EVERY run of the period ⇒ stays null and the writer
      // refuses this employee by name. Exactly the rule localization/my/borang-8a.ts applies, because
      // both screens now fill the same box from the same fact.
      const socsoBase = st.bases?.socsoEis;
      if (socsoBase !== undefined && socsoBase !== null) {
        r.wage = round2((r.wage ?? 0) + Number(socsoBase));
      }
    }
    const empRows = [...byEmp.values()];
    const missing = empRows.filter((r) => !digits(r.ic)).map((r) => r.name);
    if (missing.length) {
      throw new SocsoEisNotReadyError(`Member IC / SOCSO no. is mandatory — missing for: ${missing.join(', ')}`);
    }
    const [yy, mm] = p.periodKey.split('-').map(Number);
    // THE ONE WRITER, AND THE ONE CUTOVER. Nothing about the layout is decided on this screen.
    const layout = perkesoLayoutForPeriod(yy, mm);
    const employees = perkesoFileEmployeesFrom(empRows);
    let content: string;
    try {
      content = buildPerkesoSocsoFile({
        employer: { employerCode: co.code, myCoId: co.ssm, periodMonth: mm, periodYear: yy },
        employees,
        layout,
      });
    } catch (e) {
      // The writer's refusals are readiness failures on this screen too, and the route answers 422 for
      // them — being told at the portal is a slower way to learn the same thing.
      if (e instanceof PerkesoFileError) throw new SocsoEisNotReadyError(e.message);
      throw e;
    }
    // Totals READ BACK OUT OF THE FILE, not added up from the rows — see perkesoFileTotals for why that
    // is the only kind worth recording.
    const t = perkesoFileTotals(content, layout);
    const skbbkNotCarried = perkesoSkbbkNotCarried(layout, employees);
    const versions = [...versionSet].sort();
    return {
      filename: perkesoUploadFilename(co.code, p.periodKey),
      content,
      layout,
      totals: {
        salaryCents: t.sen.wage,
        socsoCents: t.sen.socsoEmployer + t.sen.socsoEmployee,
        eisCents: t.sen.eisEmployer + t.sen.eisEmployee,
        records: t.records,
        ...(layout === 'v2.0' ? { skbbkCents: t.sen.skbbk } : {}),
        ...(skbbkNotCarried > 0 ? { skbbkNotCarriedCents: Math.round(skbbkNotCarried * 100) } : {}),
      },
      statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION,
    };
  });
}

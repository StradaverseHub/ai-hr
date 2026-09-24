// Read-only report (item 1bb09a73) — where Form TP3 and the four figures the payroll run reads disagree.
//
// ── WHAT WENT WRONG ───────────────────────────────────────────────────────────────────────────────
// Two stores hold previous-employment money and, until this item, nothing joined them:
//
//   • `employee_tp3`             — the full LHDN TP3 (1/2026), keyed (tenant, person, assessment_year),
//                                  written by core/tp3.ts from the paper form HR is handed.
//   • `employee_statutory_my.tp3_year / tp3_net_remuneration / tp3_epf_claimed / tp3_pcb_paid /
//     tp3_zakat_paid`            — the ONLY figures core/payroll.ts reads
//                                  (`tp3Applies = e.tp3Year === pYear`, then ∑(Y−K), K, X and Z).
//
// `core/tp3.ts` never wrote the second set, so saving the form contributed nothing to PCB. On
// 2026-09-24 production held ONE row on each side, for DIFFERENT PEOPLE.
//
// The FORWARD fix shipped with this item: `saveTp3` now projects Section C onto those four columns in
// the same transaction, and `preProcessChecksTx` BLOCKS a payroll run whose employee has a Form TP3 for
// the pay year that the columns do not carry. Neither repairs a row keyed before the fix.
//
// ── WHY THIS SCRIPT DOES NOT WRITE ────────────────────────────────────────────────────────────────
// There is no `--apply`, on purpose. The approved plan promises the existing hand-entered figures are
// not overwritten until the reporter says so, and the remediation does not need a new write path: for
// every row this report lists as FORM_NOT_IN_PAYROLL, opening that employee's Form TP3 and pressing
// Save applies the projection through the ordinary audited service, one deliberate human action at a
// time, with an `employee.tp3.updated` event carrying before/after. A script that rewrote statutory
// figures in bulk would be the same silent movement of money this item was raised about.
//
// ── THE VERDICTS ──────────────────────────────────────────────────────────────────────────────────
//   FORM_NOT_IN_PAYROLL  a TP3 for year Y declares money, and `tp3_year` is not Y. Payroll seeds ZERO
//                        for that employee. THIS IS THE DEFECT; a run for year Y is now blocked.
//   AMOUNTS_DIFFER       `tp3_year` is Y and the amounts do not match the form. Legitimate if someone
//                        edited the Payroll tab by hand afterwards; worth an eye either way.
//   AGREES               the columns are exactly what the form derives.
//   PAYROLL_ONLY         `tp3_year` is set and there is no form for that year — a hand-keyed opening
//                        balance (migration / pre-system months). NOT a defect, and nothing touches it.
//   FORM_NO_MONEY        a form exists for the year but declares nothing. Nothing can be lost.
//
//   node --env-file=.env.production --import tsx scripts/report-tp3-payroll-divergence.ts
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/client';
import { employeeStatutoryMy, employeeTp3, person, tenant } from '../db/schema';
// The Section-C → accumulator-seed mapping, from the ONE place it lives. Re-deriving it here would be a
// second transcription of a statutory arithmetic, which is exactly what this item exists to prevent.
import { deriveAccumulatorSeed } from '../core/tp3';

type Verdict = 'FORM_NOT_IN_PAYROLL' | 'AMOUNTS_DIFFER' | 'AGREES' | 'PAYROLL_ONLY' | 'FORM_NO_MONEY';

const money = (v: string | number | null | undefined) => (v == null ? '—' : Number(v).toFixed(2));
const n = (v: string | null | undefined) => (v == null ? null : Number(v));

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error(
      'report-tp3-payroll-divergence requires MIGRATION_DATABASE_URL (owner role) to read both tables across tenants.',
    );
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`report-tp3-payroll-divergence — ${tenants.length} tenant(s), READ-ONLY\n`);

  const totals: Record<Verdict, number> = {
    FORM_NOT_IN_PAYROLL: 0,
    AMOUNTS_DIFFER: 0,
    AGREES: 0,
    PAYROLL_ONLY: 0,
    FORM_NO_MONEY: 0,
  };

  for (const t of tenants) {
    // ORDER BY on both reads: an asserted or printed list off a query needs one (CLAUDE.md §8), and a
    // report a human reconciles against production has to come out in the same order twice.
    const forms = await owner.db
      .select({
        personId: employeeTp3.personId,
        year: employeeTp3.assessmentYear,
        payload: employeeTp3.payload,
      })
      .from(employeeTp3)
      .where(eq(employeeTp3.tenantId, t.id))
      .orderBy(employeeTp3.personId, employeeTp3.assessmentYear);

    const stored = await owner.db
      .select({
        personId: employeeStatutoryMy.personId,
        tp3Year: employeeStatutoryMy.tp3Year,
        net: employeeStatutoryMy.tp3NetRemuneration,
        epf: employeeStatutoryMy.tp3EpfClaimed,
        pcb: employeeStatutoryMy.tp3PcbPaid,
        zakat: employeeStatutoryMy.tp3ZakatPaid,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.tenantId, t.id))
      .orderBy(employeeStatutoryMy.personId);

    const storedBy = new Map(stored.map((s) => [s.personId, s]));
    const personIds = [...new Set([...forms.map((f) => f.personId), ...stored.filter((s) => s.tp3Year != null).map((s) => s.personId)])];
    if (personIds.length === 0) continue;

    const names = new Map(
      (
        await owner.db
          .select({ id: person.id, name: person.fullName })
          .from(person)
          .where(inArray(person.id, personIds))
          .orderBy(person.id)
      ).map((p) => [p.id, p.name]),
    );

    const lines: string[] = [];

    for (const f of forms) {
      const seed = deriveAccumulatorSeed(f.payload);
      const s = storedBy.get(f.personId);
      let verdict: Verdict;
      if (!seed || (seed.netRemuneration === 0 && seed.epfClaimed === 0 && seed.pcbPaid === 0 && seed.zakatPaid === 0)) {
        verdict = 'FORM_NO_MONEY';
      } else if (!s || s.tp3Year !== f.year) {
        verdict = 'FORM_NOT_IN_PAYROLL';
      } else if (
        n(s.net) === seed.netRemuneration &&
        n(s.epf) === seed.epfClaimed &&
        n(s.pcb) === seed.pcbPaid &&
        n(s.zakat) === seed.zakatPaid
      ) {
        verdict = 'AGREES';
      } else {
        verdict = 'AMOUNTS_DIFFER';
      }
      totals[verdict] += 1;
      lines.push(
        [
          `  ${verdict.padEnd(20)}`,
          `person=${f.personId.slice(0, 8)}`,
          `name=${JSON.stringify(names.get(f.personId) ?? '?')}`,
          `formYear=${f.year}`,
          `payrollYear=${s?.tp3Year ?? '—'}`,
          `| form: net=${money(seed?.netRemuneration)} epf=${money(seed?.epfClaimed)} pcb=${money(seed?.pcbPaid)} zakat=${money(seed?.zakatPaid)}`,
          `| payroll: net=${money(s?.net)} epf=${money(s?.epf)} pcb=${money(s?.pcb)} zakat=${money(s?.zakat)}`,
        ].join(' '),
      );
    }

    // The other side: figures the payroll run WILL use that have no form behind them at all. Not a
    // defect — it is the hand-keyed opening balance this item deliberately leaves alone — but it is half
    // of what "the two stores hold different people" meant, so it is reported rather than filtered out.
    const formYearsByPerson = new Map<string, Set<number>>();
    for (const f of forms) {
      const set = formYearsByPerson.get(f.personId) ?? new Set<number>();
      set.add(f.year);
      formYearsByPerson.set(f.personId, set);
    }
    for (const s of stored) {
      if (s.tp3Year == null) continue;
      if (formYearsByPerson.get(s.personId)?.has(s.tp3Year)) continue;
      totals.PAYROLL_ONLY += 1;
      lines.push(
        [
          `  ${'PAYROLL_ONLY'.padEnd(20)}`,
          `person=${s.personId.slice(0, 8)}`,
          `name=${JSON.stringify(names.get(s.personId) ?? '?')}`,
          `formYear=—`,
          `payrollYear=${s.tp3Year}`,
          `| form: —`,
          `| payroll: net=${money(s.net)} epf=${money(s.epf)} pcb=${money(s.pcb)} zakat=${money(s.zakat)}`,
        ].join(' '),
      );
    }

    if (lines.length > 0) {
      console.log(`tenant ${t.id.slice(0, 8)} ${JSON.stringify(t.name)}`);
      for (const l of lines.sort()) console.log(l);
      console.log('');
    }
  }

  console.log('── totals ──');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(20)} ${v}`);
  if (totals.FORM_NOT_IN_PAYROLL > 0) {
    console.log(
      `\n⚠️ ${totals.FORM_NOT_IN_PAYROLL} employee-year(s) have a Form TP3 the payroll calculation is not reading.` +
        `\n   A payroll run for those years is now BLOCKED at the pre-processing checks rather than seeding zero.` +
        `\n   To apply: open each employee's Form TP3 for that year and press Save. Nothing here writes.`,
    );
  }
  process.exit(0);
}

void main();

/**
 * 05d2709a — WHICH EMPLOYEES EXIST MORE THAN ONCE AS SEPARATE PERSON RECORDS, and the evidence per pair.
 *
 * WHY THIS EXISTS, AND WHY IT COMES BEFORE THE SCREEN. The finding was made while preparing the Gender /
 * Marital Status list (fdfd8ec7): the same names kept appearing. Measured on production 2026-09-22 over
 * employments with `terminated_on IS NULL` — 10 `full_name`s held by MORE THAN ONE `person_id`, 22 extra
 * person records between them, and exactly 1 of those employments carrying any payslip row. Before a
 * screen is built on that, the numbers have to be reproducible by somebody other than the person who
 * quoted them, which is what this is for.
 *
 * ⚠️ READ-ONLY BY CONSTRUCTION. There is no insert, no update and no delete in this file, and it proposes
 * no merge. Run it as often as you like; it changes nothing and fixes nothing. A merge is its own item
 * with its own plan, AFTER the reporter has said which of these pairs are actually the same person —
 * `person_id` is referenced widely (`employee_statutory_my` is keyed on it, `tp1_relief` is keyed on it,
 * leave and attendance hang off employment), and repointing one is not a thing to do on our own judgement.
 *
 * ⚠️ THE DETECTION IS A SUGGESTION, NOT A VERDICT, so this prints EVIDENCE and never a confidence score.
 * Name plus joining date is a heuristic: it misses a duplicate entered with a typo, and it flags two
 * genuinely different people who share a common name and started together. Every field is reported as
 * SAME / DIFFERS / not recorded — three states, the third of which a percentage could never express — and
 * a group whose records carry DIFFERENT IC numbers or dates of birth is called out at the top of the
 * console summary, because "these are probably two different people" is the finding that matters most.
 *
 * ⚠️ TWO COUNTS, NOT ONE, AND THE DIFFERENCE IS A FINDING. The production measurement grouped by NAME.
 * The screen groups by NAME AND JOINING DATE, which is narrower. If those two numbers disagree, the screen
 * is showing fewer names than the measurement found, and whoever reads this report needs to know that
 * rather than discover it later. Both are printed, side by side, against the figures the approved plan
 * recorded.
 *
 * THE LIST GOES TO A FILE, THE CONSOLE GETS COUNTS. The rows name individual employees and belong in the
 * owner's hands and the reporter's report, not scrolling through an agent's terminal. Same shape and same
 * reason as scripts/report-a2c-hire-year-deltas.ts and scripts/report-missing-identity-attributes.ts.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-duplicate-person-records.ts
 */
import { writeFileSync } from 'node:fs';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  DUPLICATE_EVIDENCE_FIELDS,
  DUPLICATE_FIELD_NOT_A_CONTRADICTION,
  groupDuplicateCandidates,
  normalizeFullName,
  type DuplicateCandidateGroup,
  type DuplicateEmploymentRecord,
} from '../core/duplicate-person';
import { company, employeeStatutoryMy, employment, leaveLedger, payslip, person, tenant } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';

/** What the approved plan recorded on production, printed beside what this run finds. */
const PLAN_MEASURED = { on: '2026-09-22', names: 10, extraPersonRecords: 22, employmentsWithPayslip: 1 };

const OUT = `/var/tmp/duplicate-person-records-${todayInKualaLumpur()}.txt`;

/** Human labels for the evidence fields, in the file. Kept here, not imported from `messages/` — this is
 *  an operator report read in a terminal and a text file, never a localised screen. */
const FIELD_LABEL: Record<(typeof DUPLICATE_EVIDENCE_FIELDS)[number], string> = {
  icNumber: 'IC number',
  passportNumber: 'Passport number',
  dateOfBirth: 'Date of birth',
  fullNameExact: 'Full name (exact spelling)',
  primaryEmail: 'Work email',
  personalEmail: 'Personal email',
  gender: 'Gender',
  maritalStatus: 'Marital status',
  bankAccountNo: 'Bank account',
};

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  // ACTIVE employments only — the population the production measurement was taken over, and the one a
  // payroll run would cover. A terminated duplicate is a historical record, not an operational problem.
  const rows = await owner.db
    .select({
      tenantId: employment.tenantId,
      tenantName: tenant.name,
      employmentId: employment.id,
      personId: employment.personId,
      employeeCode: employment.employeeCode,
      companyId: employment.companyId,
      company: company.legalName,
      fullName: person.fullName,
      hiredOn: employment.hiredOn,
      joinDate: employment.joinDate,
      dateOfBirth: person.dateOfBirth,
      gender: person.gender,
      maritalStatus: person.maritalStatus,
      primaryEmail: person.primaryEmail,
      personalEmail: person.personalEmail,
      icNumber: employeeStatutoryMy.icNumber,
      passportNumber: employeeStatutoryMy.passportNumber,
      bankAccountNo: employeeStatutoryMy.bankAccountNo,
      payslipCount: sql<number>`(select count(*)::int from ${payslip} p where p.employment_id = ${employment.id})`,
      leaveLedgerEntries: sql<number>`(select count(*)::int from ${leaveLedger} l where l.employment_id = ${employment.id})`,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .innerJoin(company, eq(company.id, employment.companyId))
    .innerJoin(tenant, eq(tenant.id, employment.tenantId))
    // LEFT: a non-Malaysian, or a profile nobody has finished, has no statutory row — and an inner join
    // would drop exactly the incomplete records this list is most likely to concern.
    .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(and(isNull(employment.terminatedOn)))
    // ORDER BY on the asserted array, not "whatever came back": every count and every line below is read
    // off this order, so it has to be a property of the data.
    .orderBy(asc(employment.tenantId), asc(person.fullName), asc(employment.hiredOn), asc(employment.id));

  // ── Headline counts. Grouped PER TENANT throughout: two customers may each employ a LEE CHOO HONG, and
  //    collapsing them would invent a duplicate across an isolation boundary. ──
  const countSharedNames = (key: (r: (typeof rows)[number]) => string) => {
    const byKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = `${r.tenantId}|${key(r)}`;
      const s = byKey.get(k) ?? new Set<string>();
      s.add(r.personId);
      byKey.set(k, s);
    }
    const shared = [...byKey.values()].filter((s) => s.size >= 2);
    return { names: shared.length, extra: shared.reduce((n, s) => n + s.size - 1, 0) };
  };
  const exact = countSharedNames((r) => r.fullName);
  const normalized = countSharedNames((r) => normalizeFullName(r.fullName));

  // ── The groups the SCREEN would show, derived by the SCREEN'S OWN function so the report and the screen
  //    cannot come to describe the same people differently. ──
  const byTenant = new Map<string, { name: string; rows: Omit<DuplicateEmploymentRecord, 'personLabel'>[] }>();
  for (const r of rows) {
    const b = byTenant.get(r.tenantId) ?? { name: r.tenantName, rows: [] };
    b.rows.push(r);
    byTenant.set(r.tenantId, b);
  }

  const tenantGroups: { tenantId: string; tenantName: string; groups: DuplicateCandidateGroup[]; sharedDifferentDates: number }[] = [];
  for (const [tenantId, b] of [...byTenant.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
    const { groups, sharedNamesWithDifferentHireDates } = groupDuplicateCandidates(b.rows);
    tenantGroups.push({ tenantId, tenantName: b.name, groups, sharedDifferentDates: sharedNamesWithDifferentHireDates });
  }

  const allGroups = tenantGroups.flatMap((t) => t.groups);
  const screenNames = allGroups.length;
  const screenExtra = allGroups.reduce((n, g) => n + g.personIds.length - 1, 0);
  const crossCompany = allGroups.filter((g) => g.companies.length > 1).length;
  const withPayslip = allGroups.filter((g) => g.anyPayslip).length;
  const paidEmployments = allGroups.reduce((n, g) => n + g.records.filter((r) => r.payslipCount > 0).length, 0);
  const contradicting = allGroups.filter((g) => g.contradictions.length > 0);
  const sharedDifferentDates = tenantGroups.reduce((n, t) => n + t.sharedDifferentDates, 0);

  // ── The file. Everything that names a person lives here. ──
  const lines: string[] = [
    '05d2709a — suspected duplicate person records, with the evidence for each',
    `generated ${new Date().toISOString()}   ·   as of ${todayInKualaLumpur()}   ·   READ-ONLY`,
    '',
    'WHAT THIS LIST IS. Employees whose ACTIVE employments share a name AND a joining date but belong to',
    'MORE THAN ONE person record. One person holding several employments is normal and supported and is',
    'NOT listed here: rows sharing a Record letter below are one person record with several jobs.',
    '',
    'WHAT IT IS NOT. It is a SUGGESTION, not a verdict. Two different people can share a common name and',
    'start on the same day, and a duplicate typed with a spelling mistake is not in this list at all.',
    'Nothing here has been changed, and nothing will be merged until somebody who knows the business has',
    'said which of these are the same person.',
    '',
    'THREE FACTS THAT CHANGE HOW TO READ THE EVIDENCE.',
    '  1. The database already forces the IC number to be unique within a customer',
    '     (employee_statutory_my_ic_uq, migration 0214), so two person records can NEVER carry the same',
    '     IC. A difference there is the only shape the data can take and is NOT counted as a disagreement',
    '     below. It also suggests how these records came about: an IC that is already taken is REFUSED, so',
    '     a second record for the same human tends to be created with the IC left blank.',
    '  2. The work email is given by the employer, not by the person. Somebody employed by two companies',
    '     in one group legitimately has two, so a difference there is not counted either.',
    '  3. The exact SPELLING of the name can differ only in capitals and spacing — the grouping key is the',
    '     folded name — so it too is not counted. A cosmetic difference points AT one person entered twice.',
    '',
    `Active employments read : ${rows.length}`,
    `Tenants                 : ${byTenant.size}`,
    '',
    '='.repeat(100),
    '',
  ];

  for (const t of tenantGroups) {
    if (t.groups.length === 0 && t.sharedDifferentDates === 0) continue;
    lines.push(`TENANT: ${t.tenantName}  (${t.tenantId})`, '');
    if (t.groups.length === 0) {
      lines.push('  No name is shared by more than one person record on the same joining date.', '');
    }
    for (const g of t.groups) {
      lines.push(
        `  ${g.displayName}   ·   joined ${g.hiredOn}`,
        `    ${g.personIds.length} person records, ${g.records.length} active employments, ` +
          `${g.companies.length} compan${g.companies.length === 1 ? 'y' : 'ies'} (${g.companies.join(', ')})`,
      );
      if (g.contradictions.length > 0) {
        lines.push(
          `    ⚠️ THESE MAY BE DIFFERENT PEOPLE — the records DISAGREE on: ` +
            g.contradictions.map((f) => FIELD_LABEL[f]).join(', '),
        );
      }
      if (g.anyPayslip) lines.push('    ⚠️ AT LEAST ONE OF THESE RECORDS HAS BEEN PAID.');
      lines.push('');
      lines.push(
        '    Record | Employee ID | Company | Joined | IC | Passport | DOB | Work email | Bank a/c | Payslips | Leave entries',
      );
      lines.push('    ' + '-'.repeat(110));
      for (const r of g.records) {
        lines.push(
          `    ${r.personLabel} | ${r.employeeCode ?? '—'} | ${r.company} | ${r.hiredOn} | ` +
            `${r.icNumber ?? '—'} | ${r.passportNumber ?? '—'} | ${r.dateOfBirth ?? '—'} | ` +
            `${r.primaryEmail} | ${r.bankAccountNo ?? '—'} | ${r.payslipCount} | ${r.leaveLedgerEntries}`,
        );
      }
      lines.push('');
      lines.push('    What the person records agree and disagree on:');
      for (const a of g.agreement) {
        const state =
          a.state === 'same'
            ? 'SAME'
            : a.state === 'differs'
              ? 'DIFFERS'
              : a.recordedBy === 0
                ? 'not recorded on any record'
                : `only recorded on ${a.recordedBy} of ${g.personIds.length} records`;
        const detail = a.values.length ? `  [${a.values.join(' | ')}]` : '';
        const reason = DUPLICATE_FIELD_NOT_A_CONTRADICTION[a.field];
        const note =
          reason === 'unique_by_constraint'
            ? '   (the system forces this to be unique — a difference here proves nothing)'
            : reason === 'assigned_by_employer'
              ? '   (given by the employer, not the person — a difference here proves nothing)'
              : reason === 'cosmetic_only'
                ? '   (can differ only in capitals or spacing — a difference here proves nothing)'
                : '';
        lines.push(`      ${FIELD_LABEL[a.field].padEnd(26)} ${state}${detail}${note}`);
      }
      lines.push('');
    }
    if (t.sharedDifferentDates > 0) {
      lines.push(
        `  ${t.sharedDifferentDates} further name(s) in this tenant are held by more than one person record`,
        '  but with DIFFERENT joining dates. They are counted, not listed: sharing a name is ordinary, and',
        '  listing them would bury the records above under people who merely have a common name.',
        '',
      );
    }
    lines.push('='.repeat(100), '');
  }

  lines.push(
    'SUMMARY',
    `  names held by more than one person record (exact spelling)      : ${exact.names}   (extra person records: ${exact.extra})`,
    `  names held by more than one person record (case/space folded)   : ${normalized.names}   (extra person records: ${normalized.extra})`,
    `  ...of those, ALSO sharing one joining date  → what the screen lists: ${screenNames}   (extra person records: ${screenExtra})`,
    `  groups spanning more than one company                           : ${crossCompany}`,
    `  groups where at least one record has been paid                  : ${withPayslip}   (paid employments: ${paidEmployments})`,
    `  groups whose records DISAGREE on a recorded fact                : ${contradicting.length}`,
    `  names shared with DIFFERENT joining dates (not listed)          : ${sharedDifferentDates}`,
    '',
    `  the approved plan recorded, on production ${PLAN_MEASURED.on}: ${PLAN_MEASURED.names} names, ` +
      `${PLAN_MEASURED.extraPersonRecords} extra person records, ${PLAN_MEASURED.employmentsWithPayslip} employment with a payslip.`,
  );
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  // ── Console: COUNTS ONLY. The list names individuals and belongs in the file. ──
  console.log('05d2709a — suspected duplicate person records  (READ-ONLY; nothing was changed)');
  console.log(`  active employments read            : ${rows.length}`);
  console.log(`  tenants                            : ${byTenant.size}`);
  console.log('');
  console.log(`  names held by >1 person record     `);
  console.log(`    ...exact spelling                : ${exact.names}   (extra person records: ${exact.extra})`);
  console.log(`    ...case/space folded             : ${normalized.names}   (extra person records: ${normalized.extra})`);
  console.log(`    ...and sharing one joining date  : ${screenNames}   (extra person records: ${screenExtra})   <-- what the screen lists`);
  console.log('');
  console.log(`  groups across >1 company           : ${crossCompany}`);
  console.log(`  groups with a PAID record          : ${withPayslip}   (paid employments: ${paidEmployments})`);
  console.log(`  groups whose records DISAGREE      : ${contradicting.length}  ${contradicting.length ? '  <-- probably DIFFERENT people; look at these first' : ''}`);
  console.log(`  names shared, different join dates : ${sharedDifferentDates}  (counted, not listed)`);
  console.log('');
  // The plan's figures printed beside this run's, so a disagreement is visible here rather than found later.
  console.log(
    `  plan recorded on ${PLAN_MEASURED.on}      : ${PLAN_MEASURED.names} names, ${PLAN_MEASURED.extraPersonRecords} extra person records, ${PLAN_MEASURED.employmentsWithPayslip} paid employment`,
  );
  if (exact.names !== PLAN_MEASURED.names || exact.extra !== PLAN_MEASURED.extraPersonRecords) {
    console.log('  ⚠️ this run does NOT match the plan figures — the data has moved, or the measurement differed.');
  }
  if (screenNames !== exact.names) {
    console.log(
      `  ⚠️ the screen's name+joining-date rule lists ${screenNames} of the ${exact.names} shared names.` +
        ' The rest share a name on DIFFERENT joining dates and are deliberately not listed.',
    );
  }
  console.log('');
  console.log(`  per-pair evidence list             : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

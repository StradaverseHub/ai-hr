/**
 * fdfd8ec7 — WHO IS MISSING GENDER OR MARITAL STATUS, and therefore cannot be placed.
 *
 * WHY THIS EXISTS. r315/r316 gated leave grants on a lawful-eligibility check, and the production sweep
 * then reversed 1,862 days of Maternity Leave across 19 employees whose records POSITIVELY show they do
 * not qualify. Sixty employments still hold a maternity balance: five are correct (recorded female and
 * married) and 55 are there because gender or marital status is BLANK, so the system cannot tell whether
 * they qualify and deliberately takes nothing away from somebody it cannot place. A missing fact is not a
 * missing qualification.
 *
 * The approved plan told the reporter this is a DATA task and offered them this list. This produces it.
 *
 * READ-ONLY BY CONSTRUCTION. No insert, no update, no delete — the file contains none. Run it as often as
 * you like; it changes nothing and fixes nothing. Once the profiles are filled in, the reversal sweep is
 * idempotent and re-running it is the whole remedy: it skips a pair that already carries a reversal, and
 * refuses any pair with a debit or a source_request_id.
 *
 * THE LIST GOES TO A FILE, THE CONSOLE GETS COUNTS. The rows name individual employees, which belongs in
 * the owner's hands and the reporter's report — not scrolling through an agent's terminal. Same shape and
 * same reason as scripts/report-a2c-hire-year-deltas.ts.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-missing-identity-attributes.ts
 */
import { writeFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { employment, person } from '../db/schema';

const OUT = `/var/tmp/missing-identity-attributes-${new Date().toISOString().slice(0, 10)}.txt`;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  // ACTIVE employments only. A terminated employee's blank field is not a data task anybody needs to do.
  const rows = await owner.db
    .select({
      code: employment.employeeCode,
      name: person.fullName,
      gender: person.gender,
      maritalStatus: person.maritalStatus,
      hiredOn: employment.hiredOn,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(and(isNull(employment.terminatedOn)));

  const blank = (v: string | null) => v == null || v.trim() === '';
  const needing = rows.filter((r) => blank(r.gender) || blank(r.maritalStatus));

  const lines: string[] = [
    'fdfd8ec7 — employees whose Gender or Marital Status is not recorded',
    `generated ${new Date().toISOString()}   ·   READ-ONLY`,
    '',
    'These are the profiles the leave eligibility check cannot place. Nothing has been taken from them:',
    'a blank field never stops somebody being GRANTED leave, and it does hide a leave card, which is the',
    'safer way round for each. Filling both fields corrects the employee automatically — the card appears',
    'or disappears on the next page load, and the next Leave Generation run credits only what is due.',
    '',
    'EMPLOYEE ID | NAME | HIRED | MISSING',
    '-'.repeat(88),
  ];

  let bothMissing = 0;
  let genderOnly = 0;
  let maritalOnly = 0;
  for (const r of needing.sort((a, z) => (a.code ?? '').localeCompare(z.code ?? ''))) {
    const missing: string[] = [];
    if (blank(r.gender)) missing.push('Gender');
    if (blank(r.maritalStatus)) missing.push('Marital Status');
    if (missing.length === 2) bothMissing += 1;
    else if (missing[0] === 'Gender') genderOnly += 1;
    else maritalOnly += 1;
    lines.push(`${r.code ?? '—'} | ${r.name} | ${r.hiredOn} | ${missing.join(' + ')}`);
  }

  lines.push(
    '',
    `active employees: ${rows.length}   ·   needing attention: ${needing.length}`,
    `both fields missing: ${bothMissing}   ·   gender only: ${genderOnly}   ·   marital status only: ${maritalOnly}`,
  );
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  console.log('fdfd8ec7 — missing identity attributes');
  console.log(`  active employees      : ${rows.length}`);
  console.log(`  needing attention     : ${needing.length}`);
  console.log(`  both fields missing   : ${bothMissing}`);
  console.log(`  gender only           : ${genderOnly}`);
  console.log(`  marital status only   : ${maritalOnly}`);
  console.log(`  per-employee list     : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

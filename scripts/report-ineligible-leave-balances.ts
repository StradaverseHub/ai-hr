/**
 * d272834b — WHO IS HOLDING A LEAVE BALANCE THEY WERE NEVER ELIGIBLE FOR. READ-ONLY, ALWAYS.
 *
 * ⚠️ THIS SCRIPT WRITES NOTHING AND MUST NEVER LEARN TO. The approved plan promises the reporter, in those
 * words, that the wrongly-granted days are NOT reversed until they say so — on the reporting account that
 * is 55 employments holding a net 98-day Maternity Leave balance each, 5,390 days in total. This is the
 * list they asked for so they can decide. It opens no transaction, issues one SELECT, and there is no code
 * path in it that could adjust a ledger row. A reversal, if it is ever asked for, is a separate item with
 * its own plan, its own approval and its own audit trail (every correction to `leave_ledger` belongs to the
 * service that owns it, never to a script — see core/leave.ts).
 *
 * WHY IT IS A SCRIPT AND NOT A SCREEN. `deploy.sh` runs migrations, not scripts, so a script cannot fire
 * by accident on a release: it runs when a person runs it. That is exactly the property a report the
 * reporter has to TRIGGER needs. It is also why nothing here is scheduled — do not add it to crontab.
 *
 * WHAT IT ANSWERS, one row per (employment, leave type):
 *   · the employee code and name, the leave type code and name;
 *   · the NET days standing in the ledger (a wrongly-granted 98 that was already adjusted back nets to
 *     zero and is reported as zero — the row is still listed, because the accrual and the adjustment are
 *     both still there and they are what made the reported card appear);
 *   · GROSS accrued, so "98 granted, 98 taken back" is distinguishable from "98 granted, still standing";
 *   · WHICH FACT decides it — `gender is not recorded` / `gender 'male' is outside [female]` and the same
 *     for marital status. "Which fact is missing" was the reporter's own question and a bare "ineligible"
 *     does not answer it: a blank field is fixed by filling the profile in, a contradicted one is not.
 *
 * ⚠️ IT APPLIES THE SAME RULE THE APP DOES, by importing the gate rather than restating it.
 * `eligibilityRuleList` normalises a list holding every option the picker offers to no restriction at all,
 * so the EIGHT live types storing ["male","female"] contribute nothing to this report — a report that
 * listed them would name most of the workforce and be ignored. `isProfileEligible` with 'exclude' is the
 * identity half only: minimum service and probation say when somebody may TAKE leave, not whose leave it
 * is, and a new joiner owed Annual Leave is not a finding.
 *
 * RUN IT (the box's default node is v18 and has no --env-file):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-ineligible-leave-balances.ts
 * Add `--csv` for a spreadsheet the reporter can open. MIGRATION_DATABASE_URL (the owner role) is
 * REQUIRED and DATABASE_URL is deliberately not accepted: `leave_ledger` is RLS-bound for `ai_hr_app` and
 * this script sets no tenant GUC, so on the app role it would report ZERO findings on a database full of
 * them — the same fail-open class scripts/check-audit-chain-gate.ts documents.
 */
import postgres from 'postgres';
import { eligibilityRuleList, isProfileEligible, type LeaveEligibility } from '../core/leave';
import { ELIGIBILITY_GENDERS, MARITAL_STATUSES } from '../lib/person-vocabulary';

type Row = {
  tenant_id: string;
  employment_id: string;
  employee_code: string | null;
  full_name: string | null;
  gender: string | null;
  marital_status: string | null;
  leave_type_id: string;
  type_code: string | null;
  type_name: string;
  eligibility: unknown;
  net_days: string;
  accrued_days: string;
};

/**
 * WHY THIS PERSON FAILS THIS TYPE'S RULE, in the words the reporter asked for. Returns every failing fact,
 * not the first: an employment can be outside two criteria at once and fixing one of them would leave the
 * row on the next run, which reads as the fix not working.
 *
 * It reports ONLY the two identity criteria this item is about (gender, marital status). The eight
 * organisation-assignment criteria are deliberately left out of the WORDS — they are catalogue-backed and
 * an administrator deactivating a division would make every employment in it read as a finding — but they
 * are NOT left out of the DECISION, which is `isProfileEligible`'s alone. A row that `isProfileEligible`
 * refuses for an org reason is still listed, with `other identity criteria` as its reason, rather than
 * silently dropped.
 */
function whyIneligible(elig: LeaveEligibility, gender: string | null, marital: string | null): string[] {
  const why: string[] = [];
  const genders = eligibilityRuleList(elig.gender, ELIGIBILITY_GENDERS);
  if (genders.length > 0) {
    if (!gender) why.push('gender is not recorded');
    else if (!genders.includes(gender)) why.push(`gender '${gender}' is outside [${genders.join(', ')}]`);
  }
  const maritals = eligibilityRuleList(elig.maritalStatus, MARITAL_STATUSES);
  if (maritals.length > 0) {
    if (!marital) why.push('marital status is not recorded');
    else if (!maritals.includes(marital)) why.push(`marital status '${marital}' is outside [${maritals.join(', ')}]`);
  }
  return why;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('✗ report:ineligible-leave-balances needs MIGRATION_DATABASE_URL (the OWNER role).');
    console.error('  DATABASE_URL is deliberately NOT accepted: leave_ledger is RLS-bound for ai_hr_app and');
    console.error('  this script sets no tenant GUC, so it would report zero findings on a database full of them.');
    process.exit(2);
  }
  const csv = process.argv.includes('--csv');
  const sql = postgres(url, { max: 1 });
  try {
    // ONE SELECT, no transaction, no write. Every leave type that carries an eligibility rule, joined to
    // every employment with ledger activity on it. `archived_at` is NOT filtered: a wrong grant on a type
    // HR has since retired is still a wrong grant, and it is the case most likely to be forgotten.
    const rows = (await sql/* sql */ `
      select
        l.tenant_id,
        e.id                as employment_id,
        e.employee_code,
        p.full_name,
        p.gender,
        p.marital_status,
        t.id                as leave_type_id,
        t.code              as type_code,
        t.name              as type_name,
        t.eligibility,
        sum(l.days)                                                as net_days,
        sum(l.days) filter (where l.entry_type in ('accrual', 'in_lieu_accrual')) as accrued_days
      from leave_ledger l
        join employment e on e.id = l.employment_id
        join person p on p.id = e.person_id
        join leave_type t on t.id = l.leave_type_id
      where t.eligibility is not null
      group by l.tenant_id, e.id, e.employee_code, p.full_name, p.gender, p.marital_status,
               t.id, t.code, t.name, t.eligibility
      order by t.code nulls last, e.employee_code nulls last, e.id
    `) as unknown as Row[];

    const findings = rows.flatMap((r) => {
      const elig = (r.eligibility ?? null) as LeaveEligibility | null;
      // THE DECISION IS THE GATE'S, not this script's. 'exclude' is the DISPLAY reading — the one the
      // employee's own screens now use — so this report names exactly the employments whose cards changed.
      if (isProfileEligible(elig, { gender: r.gender, marital: r.marital_status }, 'exclude')) return [];
      const why = elig ? whyIneligible(elig, r.gender, r.marital_status) : [];
      return [
        {
          employee: r.employee_code ?? r.employment_id,
          name: r.full_name ?? '',
          employmentId: r.employment_id,
          type: r.type_code ?? r.type_name,
          typeName: r.type_name,
          net: Number(r.net_days ?? 0),
          accrued: Number(r.accrued_days ?? 0),
          why: why.length > 0 ? why.join('; ') : 'other identity criteria',
        },
      ];
    });

    if (csv) {
      console.log('employee_code,full_name,employment_id,leave_type,leave_type_name,net_days,accrued_days,reason');
      for (const f of findings) {
        console.log(
          [f.employee, f.name, f.employmentId, f.type, f.typeName, f.net.toFixed(2), f.accrued.toFixed(2), f.why]
            .map(csvCell)
            .join(','),
        );
      }
    } else {
      console.log('Leave balances held by employees the leave type is not for — REPORT ONLY, nothing changed.');
      console.log('');
      for (const f of findings) {
        console.log(
          `${(f.employee + ' ' + f.name).trim().padEnd(34)} ${f.type.padEnd(12)} net ${f.net.toFixed(2).padStart(9)}  accrued ${f.accrued.toFixed(2).padStart(9)}  — ${f.why}`,
        );
      }
      console.log('');
      // The two figures the reporter asked to see side by side: how many employments, and how many days
      // are actually STANDING (net) as opposed to granted-and-already-taken-back.
      const employments = new Set(findings.map((f) => f.employmentId)).size;
      const standing = findings.reduce((n, f) => n + f.net, 0);
      const granted = findings.reduce((n, f) => n + f.accrued, 0);
      console.log(`${findings.length} finding(s) across ${employments} employment(s).`);
      console.log(`${granted.toFixed(2)} day(s) were granted; ${standing.toFixed(2)} day(s) are still standing.`);
      console.log('Nothing was reversed. Reversing these is a separate, reporter-triggered decision.');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

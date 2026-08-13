// One-shot repair (item 5ff7daff) — ARCHIVE the duplicate replacement leave type that
// `ensureReplacementLeaveType` created before it learned to match on `leave_type.role`.
//
// WHAT WENT WRONG. core/toil.ts's ensureReplacementLeaveType used to find the tenant's replacement type by
// `lower(code) = 'replacement'`. Production's catalogue was never seeded: the customer's own replacement
// type is coded `RL`, marked `role = 'replacement'`. The match found nothing, so the function inserted a
// SECOND type — code `REPLACEMENT`, name "Replacement Leave (in lieu)" — at the moment replacement leave
// was switched on. Both resolve to ESS placement 'primary', so the employee saw TWO Replacement Leave cards,
// and every credit an approval minted would have landed on the auto-created one while the card carrying the
// customer's own name read zero forever.
//
// The CODE half of that is fixed in this same round (role first, seeded code as the fallback, at all three
// sites). This script is the DATA half: the empty duplicate the old code left behind.
//
// WHY A SCRIPT AND NOT A MIGRATION. Archiving a row of a customer's leave catalogue is a DATA decision
// about one tenant, not a schema change, and its precondition is data too: it is only safe while the
// duplicate holds NOTHING. A migration cannot check that honestly (it would run on every database,
// including ones where the duplicate IS the type in use), and if the precondition failed it would abort a
// deploy rather than tell somebody. AGENTS.md rule 13: deploy.sh runs migrations, not scripts — so this has
// to be run BY HAND after the deploy, and its rows read back afterwards.
//
// REFUSES TO ARCHIVE A TYPE THAT IS IN USE. Before touching anything it counts the rows that POINT AT the
// candidate type — leave_request and leave_ledger. Either non-zero and the type is SKIPPED with the counts
// printed, because at that point the duplicate is the type someone's balance is actually built from and
// archiving it would hide a real entitlement. (toil_accrual carries no leave_type_id: a credit is banked
// against an EMPLOYMENT and it is the ledger row it writes that names the type. The tenant-wide accrual
// count is printed as context, not used as a gate.) Measured on production 2026-08-13: all three are 0,
// which is what makes this safe there.
//
// IT ALSO REFUSES IF THE TENANT HAS NO ROLE-MARKED TYPE TO FALL BACK ON. Archiving the only replacement
// type a tenant has would leave the fixed code to create a fresh one on the next approval — a third type,
// and a worse mess than the one being cleaned up.
//
// NOTE ON `counting`: the customer's own RL type is `calendar_days` where the auto-created one was
// `working_days`. That is their setting on their own type and this script does not touch it. Flag it if it
// comes up; do not "fix" it.
//
// The box is node v18.19.1 and `--env-file=` is node 20+ (AGENTS.md rule 21) — SOURCE the env instead:
//
//   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
//     node --import tsx scripts/archive-duplicate-replacement-leave-type.ts                    # dry run
//   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
//     node --import tsx scripts/archive-duplicate-replacement-leave-type.ts --tenant=<uuid> --apply
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { leaveLedger, leaveRequest, leaveType, tenant, toilAccrual } from '../db/schema';

type Candidate = {
  id: string;
  code: string;
  name: string;
  role: string | null;
  counting: string | null;
  createdAt: Date;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
  const tenantId = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';

  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('archive-duplicate-replacement-leave-type requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  // A WRITE MUST NAME ITS TENANT. A dry run may survey every tenant on the box — that is the point of a
  // survey — but an --apply that guessed which customer was meant is the one-way mistake this whole file
  // is arranged around.
  if (apply && !tenantId) {
    console.error(
      'archive-duplicate-replacement-leave-type --apply requires --tenant=<uuid>. It writes, and it will\n' +
        'not guess which customer you meant. Run it without --apply first to see the survey, then name one.\n' +
        'List them with:  select id, name from tenant;',
    );
    process.exit(1);
  }

  const owner = createDb(ownerUrl);
  const tenants = await owner.db
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(tenantId ? eq(tenant.id, tenantId) : undefined);
  if (tenants.length === 0) {
    console.error(tenantId ? `No tenant with id ${tenantId}.` : 'No tenants.');
    process.exit(1);
  }

  console.log(
    `archive-duplicate-replacement-leave-type — ${tenants.length} tenant(s), mode=${apply ? 'APPLY' : 'dry-run'}`,
  );

  let archived = 0;
  let skipped = 0;

  for (const t of tenants) {
    // Every non-archived type this tenant has that either IS the replacement role or carries the seeded
    // code. Owner connection: RLS does not bind the owner role, so the tenant filter is explicit.
    const rows: Candidate[] = await owner.db
      .select({
        id: leaveType.id,
        code: leaveType.code,
        name: leaveType.name,
        role: leaveType.role,
        counting: leaveType.counting,
        createdAt: leaveType.createdAt,
      })
      .from(leaveType)
      .where(
        and(
          eq(leaveType.tenantId, t.id),
          isNull(leaveType.archivedAt),
          sql`(${leaveType.role} = 'replacement' or lower(${leaveType.code}) = 'replacement')`,
        ),
      )
      .orderBy(leaveType.createdAt);

    if (rows.length < 2) continue; // nothing duplicated — the overwhelming majority of tenants

    const keep = rows.find((r) => r.role === 'replacement');
    if (!keep) {
      console.log(
        `  ${t.name}: ${rows.length} replacement types but NONE marked role='replacement' — skipped.\n` +
          `    Classify the one the customer owns first (leave_type.role), or the fixed code has nothing to find.`,
      );
      skipped += 1;
      continue;
    }

    const duplicates = rows.filter((r) => r.id !== keep.id);
    console.log(`  ${t.name}:`);
    console.log(`    KEEP    ${keep.code.padEnd(12)} "${keep.name}"  role=${keep.role} counting=${keep.counting}`);

    for (const d of duplicates) {
      // THE PRECONDITION, checked per candidate and never assumed.
      //
      // `toil_accrual` carries no leave_type_id — a credit is banked against an EMPLOYMENT, and it is the
      // ledger entry it writes that names the type. So the two blocking counts are the ones that actually
      // point at this row; the tenant-wide accrual count rides along as context, because "this tenant has
      // credits somewhere" is worth seeing on the same line even when none of them are on this type.
      const [[requests], [ledger], [accruals]] = await Promise.all([
        owner.db.select({ n: count() }).from(leaveRequest).where(eq(leaveRequest.leaveTypeId, d.id)),
        owner.db.select({ n: count() }).from(leaveLedger).where(eq(leaveLedger.leaveTypeId, d.id)),
        owner.db.select({ n: count() }).from(toilAccrual).where(eq(toilAccrual.tenantId, t.id)),
      ]);
      const used = requests.n + ledger.n;
      const detail = `leave_request=${requests.n} leave_ledger=${ledger.n} (tenant toil_accrual=${accruals.n})`;

      if (used > 0) {
        console.log(
          `    IN USE  ${d.code.padEnd(12)} "${d.name}"  ${detail} — SKIPPED.\n` +
            `      Somebody's balance is built from this type. Archiving it would hide a real entitlement;\n` +
            `      merging the two types is a different job with a different answer.`,
        );
        skipped += 1;
        continue;
      }

      if (!apply) {
        console.log(`    WOULD ARCHIVE  ${d.code.padEnd(12)} "${d.name}"  ${detail} (empty) — dry run, nothing written.`);
        continue;
      }

      await owner.db
        .update(leaveType)
        .set({ archivedAt: new Date() })
        .where(and(eq(leaveType.id, d.id), isNull(leaveType.archivedAt)));
      archived += 1;
      console.log(`    ARCHIVED       ${d.code.padEnd(12)} "${d.name}"  ${detail} (empty)`);
    }

    // Read back, so the run proves what it did rather than reporting what it intended.
    const after = await owner.db
      .select({ code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(
        and(
          eq(leaveType.tenantId, t.id),
          isNull(leaveType.archivedAt),
          sql`(${leaveType.role} = 'replacement' or lower(${leaveType.code}) = 'replacement')`,
        ),
      );
    console.log(`    AFTER   ${after.length} active replacement type(s): ${after.map((a) => `${a.code} "${a.name}"`).join(', ')}`);
  }

  console.log(
    `archive-duplicate-replacement-leave-type done — ${apply ? `archived ${archived}` : 'nothing written'}, ${skipped} skipped.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

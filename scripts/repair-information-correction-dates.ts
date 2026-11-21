/** Board d09ba8a3. Dry-run first and keep the resulting manifest private.
 * node --import tsx scripts/repair-information-correction-dates.ts plan TENANT ACTOR [EMPLOYMENT]
 * node --import tsx scripts/repair-information-correction-dates.ts apply MANIFEST EXPECTED_DATABASE
 */
import { readFileSync } from 'node:fs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvents } from '../db/events';
import { appUser, domainEvent, employment, roleAssignment } from '../db/schema';
import { lockAccessConfigurationReadTx } from '../core/access-configuration-lock';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { lockEmploymentStatutoryOwnerTx } from '../core/employment-statutory-owner-lock';
import {
  alignedInformationDateSql, informationDateAlignmentValueSql, INFORMATION_CORRECTION_DATE_AGGREGATE,
  INFORMATION_CORRECTION_DATE_ALIGNED, type CorrectionDateAlignment,
} from '../core/information-correction-date';
import { latestAppliedMovementForCorrectionDateTx } from '../core/movement';
import { isCalendarDate } from '../lib/calendar-date';
import { pgSqlState } from '../lib/db-error';

const correctionType = 'employment.information.corrected';
const batchSize = 25;
const date = z.string().refine(isCalendarDate);
const adjustment = z.object({
  correctionId: z.uuid(),
  originalEffectiveOn: date,
  alignedEffectiveOn: date,
  movementId: z.uuid(),
}).strict().refine(row => row.alignedEffectiveOn < row.originalEffectiveOn);
const manifestSchema = z.object({
  version: z.literal(1),
  database: z.string().min(1),
  tenantId: z.uuid(),
  actorUserId: z.uuid(),
  subjects: z.array(z.object({ employmentId: z.uuid(), corrections: z.array(adjustment).min(1) }).strict()),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Storage = ReturnType<typeof createDb>;

async function operatorContext(storage: Storage, tenantId: string, actorUserId: string): Promise<SessionContext> {
  const [user] = await storage.db.select({ id: appUser.id, personId: appUser.personId }).from(appUser)
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.id, actorUserId)));
  if (!user) throw new Error('The operator is not a user of the named tenant.');
  const grants = await storage.db.select({ role: roleAssignment.role, companyId: roleAssignment.companyId })
    .from(roleAssignment).where(and(eq(roleAssignment.tenantId, tenantId), eq(roleAssignment.appUserId, user.id)));
  return { tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map(g => g.role))], grants };
}

async function assertSubject(tx: Tx, ctx: SessionContext, employmentId: string) {
  const [allowed] = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from employment e
      where e.tenant_id = ${ctx.tenantId}::uuid and e.id = ${employmentId}::uuid
        and app.principal_snapshot_current() and app.is_admin_for(e.company_id)
        and app.access_workforce_employment(e.id, 'workforce.maintain')
    ) as ok
  `);
  if (!allowed?.ok) throw new Error('An employment is unavailable or outside the operator’s authority.');
}

async function readCorrections(tx: Tx, tenantId: string, employmentId: string) {
  return tx.select({
    id: domainEvent.id,
    originalDate: sql<string | null>`${domainEvent.payload}->>'effectiveOn'`,
    alignedDate: alignedInformationDateSql(),
    alignmentMovementId: informationDateAlignmentValueSql('movementId'),
  }).from(domainEvent).where(and(
    eq(domainEvent.tenantId, tenantId), eq(domainEvent.subjectEmploymentId, employmentId),
    eq(domainEvent.eventType, correctionType),
    // Hire corrections use the same event family but own a distinct original-hire operation.
    sql`${domainEvent.payload}->>'source' is distinct from 'original-hire'`,
  ));
}

export function planCorrectionDateAlignments(
  corrections: Awaited<ReturnType<typeof readCorrections>>,
  movement: { id: string; effectiveDate: string } | null,
): CorrectionDateAlignment[] {
  if (!movement || !isCalendarDate(movement.effectiveDate)) return [];
  return corrections.flatMap(row => row.originalDate && isCalendarDate(row.originalDate)
    && row.originalDate > movement.effectiveDate && !row.alignedDate && !row.alignmentMovementId
    ? [{ correctionId: row.id, originalEffectiveOn: row.originalDate, alignedEffectiveOn: movement.effectiveDate, movementId: movement.id }]
    : []);
}

export async function createManifest(storage: Storage, database: string, tenantId: string, actorUserId: string, subject?: string) {
  const ctx = await operatorContext(storage, tenantId, actorUserId);
  const manifest: Manifest = { version: 1, database, tenantId, actorUserId, subjects: [] };
  let cursor: string | undefined;
  do {
    const ids: { id: string }[] = await storage.withTenant(ctx, tx => tx.select({ id: employment.id }).from(employment)
      .where(and(eq(employment.tenantId, tenantId), subject ? eq(employment.id, subject) : undefined,
        cursor ? gt(employment.id, cursor) : undefined,
        sql`exists (select 1 from domain_event c where c.tenant_id = ${employment.tenantId}
          and c.subject_employment_id = ${employment.id} and c.event_type = ${correctionType}
          and c.payload->>'source' is distinct from 'original-hire')`))
      .orderBy(employment.id).limit(batchSize));
    for (const { id } of ids) {
      const corrections = await storage.withTenant(ctx, async tx => {
        await lockAccessConfigurationReadTx(tx, tenantId);
        await assertSubject(tx, ctx, id);
        return planCorrectionDateAlignments(
          await readCorrections(tx, tenantId, id),
          await latestAppliedMovementForCorrectionDateTx(tx, tenantId, id),
        );
      });
      if (corrections.length) manifest.subjects.push({ employmentId: id, corrections });
    }
    cursor = ids.length === batchSize ? ids.at(-1)?.id : undefined;
  } while (cursor);
  return manifest;
}

export async function applyManifest(storage: Storage, manifest: Manifest) {
  const ctx = await operatorContext(storage, manifest.tenantId, manifest.actorUserId);
  const subjects = new Set<string>();
  for (const subject of manifest.subjects) {
    const id = subject.employmentId.toLowerCase();
    const corrections = new Set(subject.corrections.map(row => row.correctionId.toLowerCase()));
    if (subjects.has(id) || corrections.size !== subject.corrections.length) {
      throw new Error('The manifest repeats a repair target.');
    }
    subjects.add(id);
  }
  let written = 0;
  let alreadyAligned = 0;
  for (const subject of manifest.subjects) {
    for (let offset = 0; offset < subject.corrections.length; offset += batchSize) {
      const batch = subject.corrections.slice(offset, offset + batchSize);
      const applied = await storage.withTenant(ctx, async tx => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await lockAccessConfigurationReadTx(tx, ctx.tenantId);
        await lockLeaveDependenciesTx(tx, ctx.tenantId, [subject.employmentId]);
        await lockEmploymentStatutoryOwnerTx(tx, subject.employmentId);
        await tx.select({ id: employment.id }).from(employment)
          .where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.id, subject.employmentId))).for('update');
        await assertSubject(tx, ctx, subject.employmentId);
        const rows = new Map((await readCorrections(tx, ctx.tenantId, subject.employmentId)).map(row => [row.id, row]));
        const pending = batch.filter(wanted => {
          const actual = rows.get(wanted.correctionId);
          if (!actual || actual.originalDate !== wanted.originalEffectiveOn) {
            throw new Error('A correction binding or original date differs from the dry run.');
          }
          if (!actual.alignedDate && !actual.alignmentMovementId) return true;
          if (actual.alignedDate !== wanted.alignedEffectiveOn || actual.alignmentMovementId !== wanted.movementId) {
            throw new Error('An existing amendment differs from the dry run.');
          }
          return false;
        });
        if (!pending.length) return 0;
        const latest = await latestAppliedMovementForCorrectionDateTx(tx, ctx.tenantId, subject.employmentId);
        if (!latest || pending.some(row => row.movementId !== latest.id || row.alignedEffectiveOn !== latest.effectiveDate)) {
          throw new Error('The latest applied Movement Event changed. Run the preview again.');
        }
        await appendEvents(tx, pending.map(row => ({
            tenantId: ctx.tenantId,
            aggregateType: INFORMATION_CORRECTION_DATE_AGGREGATE,
            aggregateId: row.correctionId,
            eventType: INFORMATION_CORRECTION_DATE_ALIGNED,
            actor: actorOf(ctx),
            subjectEmploymentId: subject.employmentId,
            payload: row,
        })));
        return pending.length;
      });
      written += applied;
      alreadyAligned += batch.length - applied;
    }
  }
  return { written, alreadyAligned };
}

async function main() {
  const [mode, first, second, third, extra] = process.argv.slice(2);
  if (!first || !second || extra || (mode !== 'plan' && mode !== 'apply') || (mode === 'apply' && third)) {
    throw new Error('Usage: plan TENANT ACTOR [EMPLOYMENT] | apply MANIFEST EXPECTED_DATABASE');
  }
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Use the private installation owner connection.');
  const storage = createDb(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  try {
    const [target] = await storage.client`select current_database() as name, current_user as role`;
    if (target.role !== 'ai_hr_owner') throw new Error('The private ai_hr_owner database connection is required.');
    if (mode === 'plan') {
      console.log(JSON.stringify(await createManifest(storage, target.name, z.uuid().parse(first), z.uuid().parse(second), third && z.uuid().parse(third)), null, 2));
    } else {
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(first, 'utf8')));
      if (target.name !== second || target.name !== manifest.database) throw new Error('The selected database differs from the dry run.');
      console.log(JSON.stringify(await applyManifest(storage, manifest)));
    }
  } finally {
    await storage.client.end();
  }
}

if (process.argv[1]?.split('/').at(-1) === 'repair-information-correction-dates.ts') {
  main().catch(error => {
    const code = pgSqlState(error);
    console.error(code ? 'Repair stopped. The current transaction was rolled back. Database code ' + code
      : error instanceof Error ? error.message : 'Repair failed.');
    process.exitCode = 1;
  });
}

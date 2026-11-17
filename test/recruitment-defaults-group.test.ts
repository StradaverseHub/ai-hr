/**
 * Recruitment defaults at the shape of a real group (SCALE-AND-RELEASE-RULES rules 2 and 3).
 *
 * Every Recruitment page seeds the companies the viewer administers. That used to run the single-company seed once per
 * company (about thirty statements each): with 71 companies on staging every page view took 3–7 s. The set-based seed
 * must produce exactly the rows the single-company seed produces, and a page view over already-seeded companies must
 * write nothing. Fictional data only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { appUser, company, roleAssignment } from '../db/schema';
import { withRecruitmentTenant } from '../core/module-gate';
import { ensureRecruitmentDefaults, listJobs, recruitmentOverview, recruitmentSettings, updateStage, RecruitmentError } from '../packs/recruitment/service';
import { ensureRecruitmentDefaultsTx } from '../packs/recruitment/data';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const GROUP = 70;
let base: Base;
let admin: SessionContext;
let groupA: string[];
let groupB: string[];

async function companies(prefix: string, count: number): Promise<string[]> {
  const rows = await owner.db.insert(company).values(Array.from({ length: count }, (_, i) => ({
    tenantId: base.tenantId, legalName: `Fictional ${prefix} ${String(i + 1).padStart(2, '0')} Sdn Bhd`,
  }))).returning({ id: company.id });
  return rows.map((r) => r.id);
}

const IGNORED = ['id', 'tenant_id', 'company_id', 'created_at', 'updated_at', 'created_by_user_id', 'updated_by_user_id', 'process_id', 'stage_id'];
const TABLES = ['recruitment_stage', 'recruitment_process', 'recruitment_archive_reason', 'recruitment_company_setting', 'recruitment_evaluation_form', 'recruitment_offer_field'];

/** Every seeded row of one company, without identities or timestamps, in a stable order. */
async function snapshot(companyId: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows = await owner.client.unsafe(
      `select to_jsonb(t) - $2::text[] as row from public.${table} t where t.company_id = $1::uuid order by (to_jsonb(t) - $2::text[])::text`,
      [companyId, IGNORED]);
    out[table] = rows.map((r) => r.row);
  }
  out.recruitment_process_stage = (await owner.client`
    select s.seed_key, ps.position from recruitment_process_stage ps join recruitment_stage s on s.id = ps.stage_id
    where ps.company_id = ${companyId}::uuid order by ps.position`).map((r) => ({ seedKey: r.seed_key, position: r.position }));
  return out;
}

async function counts(ids: string[]): Promise<number[]> {
  return Promise.all(TABLES.map(async (table) => {
    const [row] = await owner.client.unsafe(`select count(*)::int as n from public.${table} where company_id = any($1::uuid[])`, [ids]);
    return row.n as number;
  }));
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  groupA = await companies('Group A', GROUP);
  groupB = await companies('Group B', GROUP);
});

describe('recruitment defaults for a 70-company group', () => {
  it('seeds every company with exactly the rows the single-company seed gives', async () => {
    await ensureRecruitmentDefaults(admin, groupA);
    await withRecruitmentTenant(admin, async (tx) => { for (const id of groupB) await ensureRecruitmentDefaultsTx(tx, admin, id); });
    const expected = await snapshot(groupB[0]);
    expect(expected.recruitment_stage).toHaveLength(9);
    expect(expected.recruitment_archive_reason).toHaveLength(7);
    expect(expected.recruitment_offer_field).toHaveLength(8);
    expect(expected.recruitment_process_stage.map((r) => (r as { position: number }).position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const id of groupA) expect(await snapshot(id)).toEqual(expected);
    expect(await counts(groupA)).toEqual(await counts(groupB));
  });

  it('writes nothing when every company already has its defaults, and keeps an edited default', async () => {
    await ensureRecruitmentDefaults(admin, groupA);
    const settings = await recruitmentSettings(admin, groupA[3]);
    const screening = settings.stages.find((s) => s.name === "Recruiter's Screening")!;
    await updateStage(admin, screening.id, { name: 'Fictional phone screen', type: 'screening', enabled: true });
    const totals = await counts(groupA);
    const [events] = await owner.client`select count(*)::int as n from domain_event where tenant_id = ${base.tenantId}::uuid`;
    const stamp = await owner.client`select max(updated_at) as at, count(*)::int as n from recruitment_stage where company_id = any(${groupA}::uuid[])`;
    await ensureRecruitmentDefaults(admin, groupA);
    expect(await owner.client`select max(updated_at) as at, count(*)::int as n from recruitment_stage where company_id = any(${groupA}::uuid[])`).toEqual(stamp);
    expect(await counts(groupA)).toEqual(totals);
    expect((await owner.client`select count(*)::int as n from domain_event where tenant_id = ${base.tenantId}::uuid`)[0].n).toBe(events.n);
    const names = (await recruitmentSettings(admin, groupA[3])).stages.map((s) => s.name);
    expect(names).toContain('Fictional phone screen');
    expect(names).not.toContain("Recruiter's Screening");
  });

  it('seeds only the companies that lack defaults in a mixed selection', async () => {
    await ensureRecruitmentDefaults(admin, groupA.slice(0, 35));
    const seededBefore = await snapshot(groupA[0]);
    await ensureRecruitmentDefaults(admin, groupA);
    expect(await snapshot(groupA[0])).toEqual(seededBefore);
    expect(await snapshot(groupA[69])).toEqual(seededBefore);
    const [row] = await owner.client`select count(distinct company_id)::int as n from recruitment_company_setting where company_id = any(${groupA}::uuid[])`;
    expect(row.n).toBe(GROUP);
  });

  it('checks a 70-company selection in one go: administrators read it, a partner of one company is refused', async () => {
    await ensureRecruitmentDefaults(admin, groupA);
    expect((await listJobs(admin, groupA)).rows).toEqual([]);
    expect((await recruitmentOverview(admin, groupA)).openJobs).toBe(0);
    const [user] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}` }).returning({ id: appUser.id });
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, companyId: groupA[0], role: 'recruiting_partner' });
    const partner: SessionContext = { ...admin, userId: user.id, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: groupA[0] }] };
    expect((await recruitmentOverview(partner, [groupA[0]])).openJobs).toBe(0);
    for (const call of [recruitmentOverview(partner, groupA), listJobs(partner, groupA), recruitmentOverview(admin, [...groupA, 'not-a-uuid'])]) {
      const error = await call.then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(RecruitmentError);
      expect((error as RecruitmentError).code).toBe('forbidden');
    }
  });

  it('refuses the whole selection when one company is not administered by the caller, writing nothing', async () => {
    const [user] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}` }).returning({ id: appUser.id });
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, companyId: groupA[0], role: 'recruiting_partner' });
    const partner: SessionContext = { ...admin, userId: user.id, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: groupA[0] }] };
    const error = await ensureRecruitmentDefaults(partner, [groupA[0], groupA[1]]).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RecruitmentError);
    expect((error as RecruitmentError).code).toBe('forbidden');
    expect(await counts([groupA[0], groupA[1]])).toEqual([0, 0, 0, 0, 0, 0]);
    await ensureRecruitmentDefaults(partner, [groupA[0]]);
    expect(await snapshot(groupA[0])).toEqual(await (async () => { await ensureRecruitmentDefaults(admin, [groupB[0]]); return snapshot(groupB[0]); })());
  });
});

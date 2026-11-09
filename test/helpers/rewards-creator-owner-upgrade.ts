/** Disposable owner-shape rehearsal for the unchanged 4100/4101 stock transaction. */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect } from 'vitest';

const pending = [
  { tag: '4100_rewards_review_creator_independence', when: 1793330003800, hash: '2b985ae73e3da8c1ce3e7015829734632bff6ac550021dc644c59b9603083dff' },
  { tag: '4101_attendance_formula_company_scope', when: 1793330003801, hash: '60d18c40db8d2f8392c81fa5ccb7cf05c12d6448321e744ebbc31605574e28f4' },
] as const;

type Reader = Pick<postgres.Sql, 'unsafe'>;
const ledger = (client: Reader) => client.unsafe<{ hash: string; created_at: string }[]>(
  'select hash, created_at::text from drizzle.__drizzle_migrations order by id');
const boundary = async (client: Reader) => (await client.unsafe(`select
  pg_has_role('ai_hr_owner','ai_hr_reward_setup_reader','MEMBER') as owner_member,
  pg_has_role('ai_hr_owner','ai_hr_reward_setup_reader','USAGE') as inherited,
  pg_has_role('ai_hr_owner','ai_hr_reward_setup_reader','SET') as settable,
  pg_has_role('ai_hr_app','ai_hr_reward_setup_reader','MEMBER') as app_member,
  has_schema_privilege('ai_hr_reward_setup_reader','app','CREATE') as schema_create,
  exists(select 1 from pg_roles where rolname='ai_hr_owner' and rolcanlogin
    and not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as restricted_owner,
  exists(select 1 from pg_roles where rolname='ai_hr_reward_setup_reader'
    and not (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as restricted_writer`))[0];
const closedBoundary = { owner_member: false, inherited: false, settable: false, app_member: false,
  schema_create: false, restricted_owner: true, restricted_writer: true };
const writer = async (client: Reader, name: 'reward_create_planned_unit' | 'reward_create_planned_unit_bound') =>
  (await client.unsafe(`select p.oid::text as oid, p.prosrc as body, p.prosecdef as definer,
    pg_get_userbyid(p.proowner) as owner, has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      where x.grantee=0 and x.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid=to_regprocedure($1)`, [`app.${name}(uuid,uuid,uuid)`]))[0];

export async function rehearseRewardsCreatorOwnerUpgrade(
  fixture: postgres.Sql, ordinaryOwner: postgres.Sql, observer: postgres.Sql, directory: string,
) {
  const journalPath = 'db/migrations/meta/_journal.json';
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const boundaryIndex = journal.entries.findIndex((row: { tag: string }) => row.tag === pending[0].tag);
  expect(boundaryIndex).toBe(721);
  const staged = journal.entries.slice(0, boundaryIndex + pending.length);
  const expectedTail = pending.map(({ tag, when, hash }, index) => {
    expect(staged[boundaryIndex + index]).toMatchObject({ tag, when });
    const path = `db/migrations/${tag}.sql`;
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(hash);
    copyFileSync(path, join(directory, `${tag}.sql`));
    return { hash, created_at: String(when) };
  });
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: staged }));

  // This fixture projects the selected DDL-owner shape on a stock-migrated
  // private database. Its preceding historical business rows remain intact.
  const [identity] = await fixture`select current_database() as db, session_user as login`;
  expect(identity.login).toBe('postgres');
  expect(identity.db).toMatch(/^ai_hr_rewards_upgrade_[0-9a-f]{32}$/);
  await fixture.unsafe(`alter database "${identity.db}" owner to ai_hr_owner`);
  await fixture`alter schema app owner to ai_hr_owner`;
  await fixture`alter schema drizzle owner to ai_hr_owner`;
  await fixture`alter table drizzle.__drizzle_migrations owner to ai_hr_owner`;
  await fixture`alter table public.reward_unit_setup owner to ai_hr_owner`;
  for (const relation of ['attendance_formula', 'attendance_formula_revision', 'attendance_formula_test',
    'attendance_formula_result', 'attendance_formula_event', 'payroll_attendance_allowance_source']) {
    await fixture.unsafe(`alter table public.${relation} owner to ai_hr_owner`);
  }
  for (const name of ['binding_guard', 'result_guard', 'ot_settlement_guard']) {
    await fixture.unsafe(`alter function app.attendance_formula_${name}() owner to ai_hr_owner`);
  }

  const [role] = await ordinaryOwner`select current_database() as db, session_user as login, current_user as effective`;
  expect(role).toEqual({ db: identity.db, login: 'ai_hr_owner', effective: 'ai_hr_owner' });
  expect(await boundary(fixture)).toEqual(closedBoundary);
  const initial = [...await ledger(fixture)];
  expect(initial).toHaveLength(boundaryIndex);
  expect(initial.at(-1)?.created_at).toBe('1793330003602');
  expect(initial).toEqual(staged.slice(0,boundaryIndex).map(({tag,when}:{tag:string;when:number})=>({
    hash:createHash('sha256').update(readFileSync(join(directory,`${tag}.sql`))).digest('hex'),created_at:String(when),
  })));
  const original = await writer(fixture, 'reward_create_planned_unit');
  expect(original).toMatchObject({ owner: 'ai_hr_reward_setup_reader', definer: true, app_execute: true, public_execute: false });
  expect(await writer(fixture, 'reward_create_planned_unit_bound')).toBeUndefined();

  // The original candidate must reproduce the installation refusal under the literal login.
  await expect(migrate(drizzle(ordinaryOwner), { migrationsFolder: directory })).rejects.toMatchObject({
    cause: { code: '42501', message: /^must be owner of function (?:app\.)?reward_create_planned_unit$/ },
  });
  expect(await ledger(fixture)).toEqual(initial);
  expect(await writer(fixture, 'reward_create_planned_unit')).toEqual(original);

  let entered = false;
  const facade = new Proxy(fixture, {
    get(target, property, receiver) {
      if (property !== 'begin') return Reflect.get(target, property, receiver);
      return (body: (tx: postgres.TransactionSql) => Promise<void>) => fixture.begin(async tx => {
        expect(entered).toBe(false);
        entered = true;
        await tx`set local lock_timeout='2s'`;
        await tx`set local statement_timeout='15s'`;
        await tx`lock table drizzle.__drizzle_migrations in exclusive mode`;
        expect(await ledger(tx)).toEqual(initial);
        expect(await boundary(tx)).toEqual(closedBoundary);
        await tx`grant ai_hr_reward_setup_reader to ai_hr_owner with inherit true, set true, admin false`;
        await tx`grant create on schema app to ai_hr_reward_setup_reader`;
        expect(await boundary(tx)).toEqual({ ...closedBoundary, owner_member: true, inherited: true, settable: true, schema_create: true });
        expect(await boundary(observer)).toEqual(closedBoundary);
        await tx`set local role ai_hr_owner`;
        const [actor] = await tx`select current_user as effective`;
        expect(actor.effective).toBe('ai_hr_owner');
        await body(tx);
        await tx`reset role`;
        await tx`revoke create on schema app from ai_hr_reward_setup_reader`;
        await tx`revoke ai_hr_reward_setup_reader from ai_hr_owner`;
        expect(await boundary(tx)).toEqual(closedBoundary);
        expect(await ledger(tx)).toEqual([...initial, ...expectedTail]);
        expect(await writer(tx, 'reward_create_planned_unit_bound')).toEqual({ ...original, app_execute: false });
        expect(await writer(tx, 'reward_create_planned_unit')).toMatchObject({
          owner: 'ai_hr_reward_setup_reader', definer: true, app_execute: true, public_execute: false,
        });
      });
    },
  });
  await migrate(drizzle(facade), { migrationsFolder: directory });
  expect(entered).toBe(true);
  expect(await boundary(observer)).toEqual(closedBoundary);
  expect(await ledger(observer)).toEqual([...initial, ...expectedTail]);
  expect(await writer(observer, 'reward_create_planned_unit_bound')).toEqual({ ...original, app_execute: false });
  const replacement = await writer(observer, 'reward_create_planned_unit');
  expect(replacement).toMatchObject({ owner: 'ai_hr_reward_setup_reader', definer: true, app_execute: true, public_execute: false });
  expect(replacement.oid).not.toBe(original.oid);
}

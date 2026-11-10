import {afterAll, beforeAll, expect, it} from 'vitest';
import {commitEmployeeImport, validateEmployeeImport} from '../core/import';
import {client} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase} from './harness';

const hint = 'app.bank_import_point_read';
async function eachAppConnection(work: (connection: Awaited<ReturnType<typeof client.reserve>>) => Promise<void>) {
  const connections: Awaited<ReturnType<typeof client.reserve>>[] = [];
  try {
    for (let i = 0; i < client.options.max; i++) connections.push(await client.reserve());
    await Promise.all(connections.map(work));
  } finally {
    for (const connection of connections) await connection.release();
  }
}

async function setSessionHint(value: string) {
  await eachAppConnection(async connection => { await connection`select set_config(${hint},${value},false)`; });
}

async function expectRestoredBackend(expectedPid: number) {
  let found = false;
  await eachAppConnection(async connection => {
    const [row] = await connection`select pg_backend_pid() as pid, current_user as role, current_setting(${hint},true) as hint`;
    if (row.pid !== expectedPid) return;
    found = true;
    expect(row).toMatchObject({role:'ai_hr_app', hint:'off'});
  });
  expect(found, 'Inspect the actual writer connection after its transaction').toBe(true);
}

beforeAll(migrateTestDb);
afterAll(closeAll);

it('scopes the point-read plan to native row effects and restores the writer on commit and rollback', async () => {
  await resetDb();
  const base = await seedBase(), ctx = adminCtx(base), hiredOn = todayInKualaLumpur();
  const record = (code: string) => ({
    employee_code: code, full_name: 'Fictional ' + code, email: code.toLowerCase() + '@fixture.test',
    department: 'Finance', hired_on: hiredOn, basic_salary: '2500',
  });
  const accepted = [record('EMP-POINT-COMMIT')];
  const rejectedAtWrite = [record('EMP-POINT-FIRST'), record('EMP-POINT-ROW-FAIL')];
  const rejectedAtCommit = [record('EMP-POINT-FIRST'), record('EMP-POINT-REFUSE')];
  const input = (records: typeof accepted) => ({companyId:base.companyId, records});
  for (const records of [accepted, rejectedAtWrite, rejectedAtCommit]) {
    const preview = await validateEmployeeImport(ctx, input(records));
    expect(preview.validCount).toBe(records.length);
    expect(preview.fileErrors).toEqual([]);
  }

  try {
    await setSessionHint('off');
    await owner.client.unsafe(`
      create schema ci_employee_import_point_read;
      create table ci_employee_import_point_read.witness (phase text not null, pid int not null, hint text not null);
      create sequence ci_employee_import_point_read.rollback_backend;
      create function ci_employee_import_point_read.observe() returns trigger
      language plpgsql security definer set search_path=pg_catalog as $body$
      declare marker text; actor name;
      begin
        if new.employee_code not like 'EMP-POINT-%' then return new; end if;
        marker:=current_setting('app.bank_import_point_read',true);
        actor:=case when current_setting('role')='none' then session_user else current_setting('role') end;
        if actor<>'ai_hr_app' or not exists(select 1 from pg_roles where rolname=actor and not rolsuper and not rolbypassrls)
           or marker is distinct from (case when tg_when='BEFORE' then 'on' else 'off' end) then
          raise exception 'Fictional import point-read scope is invalid';
        end if;
        if (new.employee_code='EMP-POINT-ROW-FAIL' and tg_when='BEFORE')
           or (new.employee_code='EMP-POINT-REFUSE' and tg_when='AFTER') then
          perform setval('ci_employee_import_point_read.rollback_backend',pg_backend_pid(),true);
          raise exception 'Intentional fictional import refusal';
        end if;
        insert into ci_employee_import_point_read.witness values(tg_when,pg_backend_pid(),marker);
        return new;
      end $body$;
      revoke all on function ci_employee_import_point_read.observe() from public;
      create trigger ci_employee_import_point_read_before before insert on public.employment
        for each row execute function ci_employee_import_point_read.observe();
      create constraint trigger ci_employee_import_point_read_after after insert on public.employment
        deferrable initially deferred for each row execute function ci_employee_import_point_read.observe();
    `).simple();

    expect(await commitEmployeeImport(ctx, input(accepted))).toMatchObject({imported:1, failed:[], fileErrors:[]});
    const witnesses = await owner.client`select phase,pid,hint from ci_employee_import_point_read.witness order by phase desc`;
    expect(witnesses).toEqual([
      {phase:'BEFORE', pid:expect.any(Number), hint:'on'}, {phase:'AFTER', pid:witnesses[0]?.pid, hint:'off'},
    ]);
    await expectRestoredBackend(witnesses[0].pid);

    for (const records of [rejectedAtWrite, rejectedAtCommit]) {
      await owner.client`select setval('ci_employee_import_point_read.rollback_backend',1,false)`;
      const refused = await commitEmployeeImport(ctx, input(records));
      expect(refused.imported).toBe(0);
      expect(refused.failed.map(row => row.rowNum)).toEqual([1,2]);
      expect(refused.fileErrors).toEqual([expect.stringMatching(/No employee rows were written\. The import was rolled back/)]);
      const [rollback] = await owner.client`select last_value::int as pid,is_called from ci_employee_import_point_read.rollback_backend`;
      expect(rollback.is_called).toBe(true);
      await expectRestoredBackend(rollback.pid);
    }
    expect(await owner.client`select employee_code from employment where tenant_id=${base.tenantId}::uuid and employee_code like 'EMP-POINT-%'`)
      .toEqual([{employee_code:'EMP-POINT-COMMIT'}]);
    expect(await owner.client`select phase,pid,hint from ci_employee_import_point_read.witness order by phase desc`).toEqual(witnesses);
    expect((await owner.client`select count(*)::int as n from domain_event
      where tenant_id=${base.tenantId}::uuid and event_type='employee-import.completed'`)[0].n).toBe(1);
  } finally {
    try { await owner.client.unsafe('drop schema if exists ci_employee_import_point_read cascade'); }
    finally { await setSessionHint(''); }
  }
});

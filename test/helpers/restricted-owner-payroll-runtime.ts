import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { taxBasisSourceRowsTx } from '../../core/payroll-tax-basis-read';
import { createDb, type SessionContext, type Tx } from '../../db/client';

const period = (index: number) => `2026-0${index + 1}`;
const signatures = [
  'app.payroll_tax_basis_original_employer_read(uuid)',
  'app.payroll_tax_import_source_revision(uuid)',
  'app.payroll_import_tax_reader_compatible(uuid,uuid,jsonb)',
  'app.payroll_tax_basis_reader_compatible(uuid,uuid)',
  'app.pay_formula_saved(text)',
  'app.pay_formula_active(text)',
  'app.pay_formula_category(uuid,text)',
];

async function seed(observer: postgres.Sql) {
  const tenant = randomUUID(), foreignTenant = randomUUID();
  const admin = randomUUID(), foreignAdmin = randomUUID(), employee = randomUUID();
  const companies = Array.from({ length: 7 }, (_, index) => ({
    id: randomUUID(), tenant: index === 6 ? foreignTenant : tenant, label: `Runtime company ${index + 1}`,
    person: randomUUID(), employment: randomUUID(), cycle: randomUUID(), payPeriod: randomUUID(),
    attempt: randomUUID(), batch: randomUUID(), slip: randomUUID(), record: randomUUID(), revision: randomUUID(),
  }));
  const [first, , , , , child] = companies;
  await observer.begin(async tx => {
    // Install a known historical import graph. Runtime reads below use the real app login and every policy.
    await tx`set local session_replication_role = replica`;
    await tx`insert into tenant(id,workos_org_id,name) values
      (${tenant},${tenant},'Fictional payroll runtime'),(${foreignTenant},${foreignTenant},'Fictional foreign runtime')`;
    await tx`insert into app_user(id,tenant_id,workos_user_id) values
      (${admin},${tenant},${admin}),(${foreignAdmin},${foreignTenant},${foreignAdmin})`;
    for (const [index, company] of companies.entries()) {
      const actor = company.tenant === tenant ? admin : foreignAdmin;
      const payrollPeriod = period(index), gross = 4001 + index, net = gross - 50;
      await tx`insert into company(id,tenant_id,legal_name) values(${company.id},${company.tenant},${company.label})`;
      await tx`insert into person(id,tenant_id,full_name,primary_email)
        values(${company.person},${company.tenant},${`Runtime Employee ${index + 1}`},${company.person + '@fixture.test'})`;
      await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code)
        values(${company.employment},${company.tenant},${company.person},${company.id},'2020-01-01',${`RUNTIME-${index + 1}`})`;
      await tx`insert into payroll_cycle(id,tenant_id,company_id,name,run_type)
        values(${company.cycle},${company.tenant},${company.id},'Monthly','regular')`;
      await tx`insert into pay_period(id,tenant_id,company_id,period,status)
        values(${company.payPeriod},${company.tenant},${company.id},${payrollPeriod},'closed')`;
      const bytes = Buffer.from('fictional payroll runtime fixture');
      await tx`insert into payroll_history_import_attempt(id,tenant_id,created_by,operation_key,source_name,mime_type,
        source_hash,source_content,company_ids,plan)
        select ${company.attempt},${company.tenant},${actor},${randomUUID()},'runtime.csv','text/csv',hash,${bytes},
          array[${company.id}::uuid],jsonb_build_object('sourceHash',hash,'rows','[]'::jsonb)
        from (select encode(sha256(${bytes}::bytea),'hex') as hash) source`;
      await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,run_seq,
        run_type,pay_period_id,payroll_cycle_id,history_import_attempt_id,history_import_cycle_name,closed_at)
        values(${company.batch},${company.tenant},${company.id},${payrollPeriod},${payrollPeriod + '-28'},'closed',1,'{}',1,
          'adjustment',${company.payPeriod},${company.cycle},${company.attempt},'Monthly',now())`;
      await tx`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,allowance,gross_pay,statutory,
        other_deductions,total_deductions,net_pay,employer_cost)
        values(${company.slip},${company.tenant},${company.batch},${company.employment},4000,0,${gross},
          '{"importedTaxBasis":{}}',0,50,${net},4100)`;
      await tx`insert into payroll_history_import_record(id,tenant_id,company_id,employment_id,period,cycle_id)
        values(${company.record},${company.tenant},${company.id},${company.employment},${payrollPeriod},${company.cycle})`;
      await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
        values(${company.slip},${company.tenant},${company.record},repeat('a',64),'{}')`;
      await tx`insert into payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,kind,cycle_name)
        values(${company.revision},${company.tenant},${company.record},1,${company.attempt},${company.slip},'import','Monthly')`;
      if (index < 4) {
        await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role)
          values(${tenant},${admin},${company.id},'hr_admin')`;
      }
    }

    const mapping = randomUUID();
    await tx`insert into company_organisation_run(id,tenant_id,kind,effective_on,state,company_ids,authority_company_ids,
      mapping,source_epoch,digest,requested_by,published_at)
      values(${mapping},${tenant},'mapping','2020-01-01','published',array[${child.id}::uuid],array[${first.id}::uuid],
        '{}',0,'fictional',${admin},now())`;
    await tx`insert into company_organisation_mapping(run_id,tenant_id,company_id,parent_company_id,business_group_id)
      values(${mapping},${tenant},${child.id},${first.id},${first.id})`;

    await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${employee},${tenant},${employee},${first.person})`;
    await tx`insert into role_assignment(tenant_id,app_user_id,role) values(${tenant},${employee},'employee')`;

    const preview = randomUUID(), correction = randomUUID();
    await tx`insert into payroll_tax_basis_preview(id,tenant_id,company_id,created_by,preview,selection,preview_hash,expires_at)
      values(${preview},${tenant},${first.id},${admin},'{}','{}',repeat('a',64),now()+interval '1 day')`;
    await tx`insert into payroll_tax_basis_batch(id,tenant_id,company_id,preview_id,created_by)
      values(${correction},${tenant},${first.id},${preview},${admin})`;
    await tx`insert into payroll_tax_basis_revision(tenant_id,company_id,employment_id,payslip_id,period,source_hash,ordinal,batch_id,basis)
      values(${tenant},${first.id},${first.employment},${first.slip},${period(0)},repeat('a',64),1,${correction},'{"version":1}')`;

    const formula = randomUUID(), revision = randomUUID(), receipt = randomUUID();
    await tx`insert into pay_formula(id,tenant_id,formula_id,created_by) values(${formula},${tenant},'RUNTIME_FORMULA',${admin})`;
    await tx`insert into pay_formula_revision(id,tenant_id,formula_id,ordinal,description,method,source,program,content_hash,
      dependencies,dependency_snapshot,created_by)
      values(${revision},${tenant},${formula},1,'Fictional formula','write','1','{"version":1}',repeat('b',64),'[]','{}',${admin})`;
    await tx`insert into pay_formula_test(id,tenant_id,revision_id,company_id,employment_id,actor_id,context,source_fingerprint,
      dependency_fingerprint,evaluator_version,registry_version,passed,amount,explanations,read_requirements)
      values(${receipt},${tenant},${revision},${first.id},${first.employment},${admin},'{}','fixture','fixture','fixture','fixture',
        true,'1','[]','{"categories":["compensation"],"fieldIds":[],"workforce":false}')`;
    await tx`insert into pay_formula_event(tenant_id,formula_id,revision_id,test_id,kind,actor_id)
      values(${tenant},${formula},${revision},${receipt},'activated',${admin})`;
  });
  return { tenant, admin, employee, companies };
}

function latestPeriod(tx: Tx, companyIds: string[]) {
  // The dashboard's no-period first read, including the effective imported employee count.
  return tx.execute<{ period: string | null }>(sql`
    select max(b.pay_period) as period
    from payroll_history_effective_batch b inner join company c on c.id=b.company_id
    where b.company_id in (${sql.join(companyIds.map(id => sql`${id}::uuid`), sql`, `)})
      and (b.history_import_attempt_id is null or b.employee_count>0)
  `);
}

export async function assertRestrictedOwnerPayrollRuntime(observer: postgres.Sql, appUrl: string) {
  const app = createDb(appUrl, { max: 1 });
  try {
    const [role] = await app.client`select session_user::text as session, current_user::text as actor, rolsuper, rolbypassrls
      from pg_roles where rolname=current_user`;
    assert.deepEqual({ ...role }, { session: 'ai_hr_app', actor: 'ai_hr_app', rolsuper: false, rolbypassrls: false });
    const [hierarchy] = await observer`select pg_get_userbyid(relowner) as owner, relrowsecurity, relforcerowsecurity
      from pg_class where oid='public.company_organisation_mapping'::regclass`;
    assert.deepEqual({ ...hierarchy }, { owner: 'ai_hr_owner', relrowsecurity: true, relforcerowsecurity: true });

    const fixture = await seed(observer);
    const [first, second, , revoked, ungranted, child, foreign] = fixture.companies;
    const direct = fixture.companies.slice(0, 4).map(row => row.id);
    const adminCtx = (ids: string[]): SessionContext => ({
      tenantId: fixture.tenant, userId: fixture.admin, roles: ['hr_admin'],
      grants: ids.map(companyId => ({ role: 'hr_admin', companyId })),
    });
    const all = adminCtx(direct);

    // The child is granted only through the published mapping, forcing a real ancestry read.
    await app.withTenant(adminCtx([child.id]), async tx => {
      const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.payroll_tax_basis_original_employer_read(${child.batch}::uuid) as ok`);
      assert.equal(allowed.ok, true, 'published inherited access must reach the forced-RLS hierarchy');
    });
    await app.withTenant(all, async tx => {
      for (const [index, company] of fixture.companies.slice(0, 4).entries()) {
        const [latest] = await latestPeriod(tx, [company.id]);
        assert.equal(latest.period, period(index), company.label);
        const [batch] = await tx.execute<{ period: string; count: number; net: string }>(sql`
          select pay_period as period,employee_count as count,totals->>'net' as net
          from payroll_history_effective_batch where id=${company.batch}::uuid`);
        assert.deepEqual({ ...batch }, { period: period(index), count: 1, net: `${3951 + index}.00` });
        // Different query shapes may evaluate the source revision check independently.
        const sources = await taxBasisSourceRowsTx(tx, [company.slip]);
        assert.deepEqual(sources.map(source => source.importRevision), [company.revision]);
      }
      const [latest] = await latestPeriod(tx, direct);
      assert.equal(latest.period, period(3));
      for (const company of [ungranted, foreign]) {
        const [result] = await latestPeriod(tx, [company.id]);
        assert.equal(result.period, null, company.label);
        assert.equal((await taxBasisSourceRowsTx(tx, [company.slip])).length, 0, company.label);
        const [category] = await tx.execute<{ ok: boolean }>(sql`select app.pay_formula_category(${company.id}::uuid,'compensation') as ok`);
        assert.equal(category.ok, false, company.label);
      }
      const [formula] = await tx.execute<{ saved: number; active: number; category: boolean }>(sql`
        select (select ordinal from app.pay_formula_saved('RUNTIME_FORMULA')) as saved,
               (select ordinal from app.pay_formula_active('RUNTIME_FORMULA')) as active,
               app.pay_formula_category(${first.id}::uuid,'compensation') as category`);
      assert.deepEqual({ ...formula }, { saved: 1, active: 1, category: true });
    });
    for (const [index, id] of direct.entries()) {
      await app.withTenant(adminCtx([id]), async tx => assert.equal((await latestPeriod(tx, [id]))[0].period, period(index)));
    }

    for (const [flag, message] of [
      ['app.payroll_import_tax_basis_reader', /import-aware income-tax reader/],
      ['app.payroll_tax_basis_reader', /correction-aware income-tax reader/],
    ] as const) {
      await assert.rejects(app.withTenant(all, async tx => {
        await tx.execute(sql`select set_config(${flag},'0',true)`);
        await tx.execute(sql`select id from payslip where id=${first.slip}::uuid`);
      }), (error: unknown) => {
        const failure = error as { code?: string; message: string; cause?: { code?: string; message: string } };
        const pg = failure.cause ?? failure;
        return pg.code === '55000' && message.test(pg.message);
      });
    }

    // Keep one transaction's captured identity while another connection commits the revocation.
    await app.withTenant(all, async tx => {
      assert.equal((await latestPeriod(tx, [revoked.id]))[0].period, period(3));
      await observer.begin(async control => {
        await control`set local session_replication_role = replica`;
        const removed = await control`delete from role_assignment where app_user_id=${fixture.admin}
          and company_id=${revoked.id} returning role`;
        assert.equal(removed.length, 1);
      });
      assert.equal((await latestPeriod(tx, [revoked.id]))[0].period, null);
      assert.equal((await tx.execute(sql`select id from payslip where id=${revoked.slip}::uuid`)).length, 0);
    });
    await app.withTenant(adminCtx(direct.slice(0, 3)), async tx => {
      assert.equal((await latestPeriod(tx, [first.id]))[0].period, period(0));
      assert.equal((await latestPeriod(tx, [revoked.id]))[0].period, null);
    });
    const self: SessionContext = {
      tenantId: fixture.tenant, userId: fixture.employee, roles: ['employee'],
      grants: [{ role: 'employee', companyId: null }],
    };
    const readOwnRows = async (tx: Tx) => {
      const slips = await tx.execute<{ id: string }>(sql`
        select id from payslip where id in (${first.slip}::uuid,${second.slip}::uuid,${foreign.slip}::uuid)`);
      const batches = await tx.execute<{ id: string }>(sql`
        select id from payroll_batch where id in (${first.batch}::uuid,${second.batch}::uuid,${foreign.batch}::uuid)`);
      return { slips: slips.map(row => row.id), batches: batches.map(row => row.id) };
    };
    const ownRows = { slips: [first.slip], batches: [first.batch] };
    const noRows = { slips: [], batches: [] };
    assert.deepEqual(await app.withTenant(self, readOwnRows), ownRows);

    await observer`update public.employment set terminated_on=current_date-1 where id=${first.employment}`;
    const [login] = await observer`select app.login_blocked(${fixture.employee}::uuid) as blocked`;
    assert.equal(login.blocked, true, 'former-employee history does not enable login');
    assert.deepEqual(await app.withTenant(self, readOwnRows), ownRows);
    for (const role of ['hr_admin', 'super_admin', 'payroll_partner']) {
      const grants = [...(self.grants ?? []), { role, companyId: second.id }];
      assert.deepEqual(await app.withTenant({
        ...self, roles: ['employee', role], grants,
      }, readOwnRows), noRows, `a stale ${role} claim denies the self-history exception`);
      assert.deepEqual(await app.withTenant({
        ...self, grants,
      }, readOwnRows), noRows, `a stale ${role} grant denies self-history even when roles says employee only`);
    }
    assert.deepEqual(await app.withTenant({
      ...self, tenantId: foreign.tenant,
    }, readOwnRows), noRows, 'a tenant mismatch must not qualify for the self-history exception');

    await observer`update public.employment set blacklisted_at=now() where id=${first.employment}`;
    assert.deepEqual(await app.withTenant(self, readOwnRows), noRows, 'blacklisted employment is not leaver evidence');
    await observer`update public.employment set blacklisted_at=null where id=${first.employment}`;
    await observer`update public.app_user set archived_at=now() where id=${fixture.employee}`;
    assert.deepEqual(await app.withTenant(self, readOwnRows), noRows, 'an archived identity cannot read employee history');
    await observer`update public.app_user set archived_at=null where id=${fixture.employee}`;
    assert.deepEqual(await app.withTenant(self, readOwnRows), ownRows, 'the restored identity still has its employee grant');
    await observer.begin(async control => {
      await control`set local session_replication_role = replica`;
      const removed = await control`delete from role_assignment where app_user_id=${fixture.employee}
        and role='employee' returning role`;
      assert.equal(removed.length, 1);
    });
    assert.deepEqual(await app.withTenant(self, readOwnRows), noRows, 'revoking the employee grant denies self-history');

    const [leaverHelper] = await observer`select p.prosecdef as definer,pg_get_userbyid(p.proowner) as owner,
      'row_security=on'=any(p.proconfig) as rls,
      array(select a.grantee::regrole::text from aclexplode(p.proacl) a
        where a.privilege_type='EXECUTE' and not a.is_grantable order by a.grantee::regrole::text) as executors,
      (select count(*)::int from aclexplode(p.proacl)) as acl_count
      from pg_proc p where p.oid='app.payroll_leaver_self_history()'::regprocedure`;
    assert.deepEqual({ ...leaverHelper }, {
      definer: true, owner: 'ai_hr_owner', rls: true, executors: ['ai_hr_app', 'ai_hr_owner'], acl_count: 2,
    });

    const active = await observer<{ patched: boolean }[]>`
      select p.prosecdef and pg_get_userbyid(p.proowner)='ai_hr_owner'
        and 'row_security=on'=any(p.proconfig) as patched
      from unnest(${signatures}::text[]) signature
      join pg_proc p on p.oid=to_regprocedure(signature)`;
    assert.equal(active.length, signatures.length);
    assert.ok(active.every(row => row.patched), 'all seven definers use the installed owner and apply row security');
  } finally {
    await app.client.end({ timeout: 5 });
  }
}

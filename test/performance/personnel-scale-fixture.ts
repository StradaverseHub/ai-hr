/** Fictional at-size Personnel workload: several companies, departments and dated assignments, with
 * an HR administrator and a scoped manager read through the real configurable Workforce access owners.
 * Bulk rows are written by the migration owner (like personnel-native-fixture.ts); every read under
 * test still runs as ai_hr_app under RLS. All names, codes and addresses are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {publishWorkforceCapabilities} from '../../deploy/access/publish-workforce-capabilities';
import {adminCtx,owner,resetDb,seedBase,type Base} from '../harness';

export type PersonnelScaleFixture = {
  base: Base;
  count: number;
  today: string;
  companies: {a: string; b: string; c: string; d: string};
  departments: Record<'a'|'b'|'c'|'d', string[]>;
  businessUnits: string[];
  positions: string[];
  /** Group-wide HR administrator: sees every company. */
  admin: SessionContext;
  /** Manager with workforce.view allowed on B (and its descendant C) and D, explicitly denied on C. */
  manager: SessionContext;
  managerVisibleCompanies: string[];
};

const WORKFORCE_CAPABILITIES = ['workforce.view', 'workforce.maintain', 'profile.review'];

/** Resets the worker database and seeds `count` fictional employments. */
export async function seedPersonnelScaleFixture(count: number): Promise<PersonnelScaleFixture> {
  await resetDb();
  const base = await seedBase();
  const today = todayInKualaLumpur();
  const t = base.tenantId;
  const [b] = await owner.client<{id: string}[]>`insert into company(tenant_id,legal_name,company_label)
    values(${t}::uuid,'Fictional Beta Holdings','BETA') returning id`;
  const [c] = await owner.client<{id: string}[]>`insert into company(tenant_id,legal_name,company_label,parent_company_id)
    values(${t}::uuid,'Fictional Gamma Services','GAMMA',${b.id}::uuid) returning id`;
  const [d] = await owner.client<{id: string}[]>`insert into company(tenant_id,legal_name,company_label)
    values(${t}::uuid,'Fictional Delta Trading','DELTA') returning id`;
  const companies = {a: base.companyId, b: b.id, c: c.id, d: d.id};
  const keys = ['a', 'b', 'c', 'd'] as const;
  const departments = {} as Record<'a'|'b'|'c'|'d', string[]>;
  const businessUnits: string[] = [], positions: string[] = [], costCenters: string[] = [], locations: string[] = [];
  for (const key of keys) {
    const companyId = companies[key];
    const made = await owner.client<{id: string}[]>`insert into department(tenant_id,company_id,name,label)
      select ${t}::uuid,${companyId}::uuid,'Fictional '||${key.toUpperCase()}||' department '||n,
        case when n%3=0 then 'Dept '||${key.toUpperCase()}||n end
      from generate_series(1,6) n returning id`;
    departments[key] = key === 'a' ? [base.deptA, base.deptB, ...made.slice(0, 4).map(row => row.id)] : made.map(row => row.id);
    businessUnits.push(...(await owner.client<{id: string}[]>`insert into business_unit(tenant_id,company_id,code,name)
      select ${t}::uuid,${companyId}::uuid,'BU'||${key.toUpperCase()}||n,'Fictional unit '||${key.toUpperCase()}||n
      from generate_series(1,2) n returning id`).map(row => row.id));
    positions.push(...(await owner.client<{id: string}[]>`insert into position(tenant_id,company_id,title,label)
      select ${t}::uuid,${companyId}::uuid,'Fictional role '||n,case when n=2 then 'Senior role' end
      from generate_series(1,4) n returning id`).map(row => row.id));
    costCenters.push(...(await owner.client<{id: string}[]>`insert into cost_center(tenant_id,company_id,code,name)
      select ${t}::uuid,${companyId}::uuid,'CC'||${key.toUpperCase()}||n,'Fictional cost '||${key.toUpperCase()}||n
      from generate_series(1,2) n returning id`).map(row => row.id));
    locations.push(...(await owner.client<{id: string}[]>`insert into location(tenant_id,company_id,code,name)
      select ${t}::uuid,${companyId}::uuid,'LOC'||${key.toUpperCase()}||n,'Fictional site '||${key.toUpperCase()}||n
      from generate_series(1,2) n returning id`).map(row => row.id));
  }
  const grades = (await owner.client<{id: string}[]>`insert into job_grade(tenant_id,code,name,rank)
    select ${t}::uuid,code,'Grade '||code,ordinality from unnest(array['H','12','13','14','15','16']) with ordinality as g(code,ordinality)
    returning id`).map(row => row.id);

  const personPrefix = randomUUID().slice(0, 24), employmentPrefix = randomUUID().slice(0, 24);
  const companyArray = keys.map(key => companies[key]);
  const names = `array['Aisyah','Ahmad','Siew Ling','Kumar','Mei Hua','Farid','Priya','Tan','Nurul','Daniel','Hafiz','Chong',
    'Lakshmi','Zainab','Wei Jie','Rajesh','Amirah','Ong','Sofia','Iskandar']`;
  const surnames = `array['Abdullah','Tan','Lim','Raj','Wong','Ismail','Chan','Kaur','Lee','Hassan','Ng','Yusof','Fictional']`;
  await owner.client.begin(async tx => {
    await tx.unsafe(`insert into person(id,tenant_id,full_name,primary_email)
      select f.person_id,$1::uuid,
        (${names})[1+(f.n*7)%20]||' '||(${surnames})[1+(f.n*11)%13]||case when f.n%9=0 then '' else ' '||(f.n%97)::text end,
        'fictional.'||f.n||'@example.invalid'
      from (${fixtureSql(personPrefix, employmentPrefix, count)}) f`, [t]);
    await tx.unsafe(`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,join_date,grade_id,
        confirmation_date,final_confirmation_date,probation_end_date,terminated_on,resignation_date,last_working_date,blacklisted_at)
      select f.employment_id,$1::uuid,f.person_id,($2::uuid[])[f.company_index],'FX'||lpad(f.n::text,6,'0'),f.hired_on,
        case when f.n%10<7 then f.hired_on + (f.n%30) end,
        case when f.n%7<6 then ($3::uuid[])[1+f.n%6] end,
        case when f.hired_on < $4::date - 200 and f.n%5<>4 then f.hired_on + 180 end,
        case when f.hired_on < $4::date - 200 and f.n%11=0 then f.hired_on + 190 end,
        case when f.n%3=0 then f.hired_on + 90 end,
        case when f.n%10=3 then least($4::date - 1, f.hired_on + 400 + f.n%700) end,
        case when f.n%20=7 then greatest(f.hired_on, $4::date - 10) when f.n%20=11 then greatest(f.hired_on, least($4::date - 5, f.hired_on + 300)) end,
        case when f.n%20=7 then $4::date + 20 when f.n%20=11 then greatest(f.hired_on, least($4::date - 2, f.hired_on + 330)) end,
        case when f.n%250=5 then greatest(f.hired_on, least($4::date - 3, f.hired_on + 100)) end
      from (${fixtureSql(personPrefix, employmentPrefix, count)}) f`, [t, companyArray, grades, today]);
    // Dated assignment history: an earlier placement (some in another company), the current placement,
    // a scheduled future change for some, and superseded corrections that must never be read.
    await tx.unsafe(`insert into assignment(tenant_id,employment_id,company_id,department_id,position_id,business_unit_id,
        cost_center_id,location_id,employment_type,valid_from,valid_to,superseded_at)
      with f as (select f.*, f.hired_on + 200 + f.n%400 as changed_on,
          case when f.n%25=0 then 1 + f.company_index%4 else f.company_index end as earlier_company
        from (${fixtureSql(personPrefix, employmentPrefix, count)}) f)
      select $1::uuid,f.employment_id,($2::uuid[])[f.earlier_company],
        ($3::uuid[])[(f.earlier_company-1)*6 + 1 + (f.n+3)%6],($4::uuid[])[(f.earlier_company-1)*4 + 1 + (f.n+1)%4],
        ($5::uuid[])[(f.earlier_company-1)*2 + 1 + (f.n+1)%2],null::uuid,null::uuid,'full_time'::employment_type,f.hired_on,f.changed_on,null::timestamptz
      from f where f.changed_on < $8::date
      union all
      select $1::uuid,f.employment_id,($2::uuid[])[f.company_index],
        ($3::uuid[])[(f.company_index-1)*6 + 1 + f.n%6],($4::uuid[])[(f.company_index-1)*4 + 1 + f.n%4],
        case when f.n%13<>0 then ($5::uuid[])[(f.company_index-1)*2 + 1 + f.n%2] end,
        ($6::uuid[])[(f.company_index-1)*2 + 1 + f.n%2],($7::uuid[])[(f.company_index-1)*2 + 1 + (f.n/2)%2],
        (array['full_time','part_time','contract','intern']::employment_type[])[1 + (f.n%17)%4],
        case when f.changed_on < $8::date then f.changed_on else f.hired_on end,
        case when f.n%30=2 then greatest($8::date + 15, f.hired_on + 1) end,null::timestamptz
      from f
      union all
      select $1::uuid,f.employment_id,($2::uuid[])[f.company_index],
        ($3::uuid[])[(f.company_index-1)*6 + 1 + (f.n+2)%6],($4::uuid[])[(f.company_index-1)*4 + 1 + f.n%4],
        ($5::uuid[])[(f.company_index-1)*2 + 1 + f.n%2],null::uuid,null::uuid,'full_time'::employment_type,greatest($8::date + 15, f.hired_on + 1),null::date,null::timestamptz
      from f where f.n%30=2
      union all
      select $1::uuid,f.employment_id,($2::uuid[])[f.company_index],
        ($3::uuid[])[(f.company_index-1)*6 + 1 + (f.n+4)%6],null::uuid,null::uuid,null::uuid,null::uuid,'contract'::employment_type,
        case when f.changed_on < $8::date then f.changed_on else f.hired_on end,null::date,now() - interval '2 days'
      from f where f.n%10=1`,
      [t, companyArray, keys.flatMap(key => departments[key]), positions, businessUnits, costCenters, locations, today]);
    // Reporting lines: one manager per block of 25, a closed earlier line for some, none for 1 in 12.
    await tx.unsafe(`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from,valid_to,superseded_at)
      with f as (select * from (${fixtureSql(personPrefix, employmentPrefix, count)}) f)
      select $1::uuid,f.employment_id,m.employment_id,'administrative'::reporting_line_type,f.hired_on,null,null
      from f join f m on m.n = ((f.n-1)/25)*25 + 1 where f.n%25<>1 and f.n%12<>5
      union all
      select $1::uuid,f.employment_id,m.employment_id,'administrative'::reporting_line_type,f.hired_on - 30,f.hired_on,null
      from f join f m on m.n = ((f.n-1)/25)*25 + 26 where f.n%25<>1 and f.n%5=0 and m.n<>f.n`, [t]);
    // Accounts for most people; Personnel reads must not depend on them.
    await tx.unsafe(`insert into app_user(tenant_id,workos_user_id,person_id)
      select $1::uuid,'fictional-'||f.n||'-'||$2,f.person_id from (${fixtureSql(personPrefix, employmentPrefix, count)}) f where f.n%5<>0`,
      [t, employmentPrefix]);
    // Ordinary event history the dated-company resolver must skip: hires and past corrections.
    await tx.unsafe(`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload,occurred_at)
      select $1::uuid,'employment',f.employment_id,'employment.hired','system'::actor_type,f.employment_id,jsonb_build_object('hiredOn',f.hired_on),f.hired_on::timestamptz
      from (${fixtureSql(personPrefix, employmentPrefix, count)}) f
      union all
      select $1::uuid,'employment',f.employment_id,'employment.information.corrected','system'::actor_type,f.employment_id,
        jsonb_build_object('effectiveOn',(f.hired_on + 10)::text,'before',jsonb_build_object('companyId','')),f.hired_on::timestamptz + interval '10 days'
      from (${fixtureSql(personPrefix, employmentPrefix, count)}) f where f.n%50=3`, [t]);
    await tx.unsafe(`insert into employee_draft(tenant_id,company_id,label,data,current_step)
      select $1::uuid,($2::uuid[])[1 + n%4],'Fictional draft '||n,'{}'::jsonb,1 from generate_series(1,6) n`, [t, companyArray]);
  });

  // The real capability publication path, then per-user allow/deny overrides for the manager.
  await publishWorkforceCapabilities(owner.client);
  const [managerPerson] = await owner.client<{personId: string; employmentId: string}[]>`
    select e.person_id as "personId",e.id as "employmentId" from employment e
    where e.tenant_id=${t}::uuid and e.company_id=${companies.b}::uuid and e.terminated_on is null
      and exists(select 1 from reporting_line r where r.manager_employment_id=e.id)
    order by e.employee_code limit 1`;
  const [managerUser] = await owner.client<{id: string}[]>`insert into app_user(tenant_id,workos_user_id,person_id)
    values(${t}::uuid,${'fictional-manager-' + randomUUID()},${managerPerson.personId}::uuid) returning id`;
  await owner.client`insert into role_assignment(tenant_id,app_user_id,company_id,role) values
    (${t}::uuid,${managerUser.id}::uuid,${companies.b}::uuid,'employee'),
    (${t}::uuid,${managerUser.id}::uuid,${companies.b}::uuid,'manager')`;
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values
    (${t}::uuid,${managerUser.id}::uuid,'workforce.view',${companies.b}::uuid,'allow'),
    (${t}::uuid,${managerUser.id}::uuid,'workforce.view',${companies.d}::uuid,'allow'),
    (${t}::uuid,${managerUser.id}::uuid,'workforce.view',${companies.c}::uuid,'deny')`;
  for (const table of ['person', 'employment', 'assignment', 'reporting_line', 'company', 'department', 'position',
    'business_unit', 'app_user', 'role_assignment', 'domain_event', 'access_user_override', 'employee_draft'])
    await owner.client.unsafe('analyze ' + table);

  const admin: SessionContext = {...adminCtx(base), grants: [{role: 'hr_admin', companyId: null}]};
  const manager: SessionContext = {
    tenantId: t, userId: managerUser.id, personId: managerPerson.personId, roles: ['employee', 'manager'],
    grants: [{role: 'employee', companyId: companies.b}, {role: 'manager', companyId: companies.b}],
    entitlements: admin.entitlements,
  };
  const [counts] = await owner.client<{employees: number; assignments: number; lines: number}[]>`select
    (select count(*)::int from employment where tenant_id=${t}::uuid) as employees,
    (select count(*)::int from assignment where tenant_id=${t}::uuid) as assignments,
    (select count(*)::int from reporting_line where tenant_id=${t}::uuid) as lines`;
  expect(counts.employees).toBe(count);
  expect(counts.assignments).toBeGreaterThan(count);
  const [identity] = await withTenant(admin, tx => tx.execute<{role: string}>(sql`select current_user as role`));
  expect(identity.role).toBe('ai_hr_app');
  return {base, count, today, companies, departments, businessUnits, positions, admin, manager,
    managerVisibleCompanies: [companies.b, companies.d].sort()};
}

/** Restore the capability catalogue that the default suite assumes (unsupported, no bindings). */
export async function restoreWorkforceCapabilityCatalogue() {
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${WORKFORCE_CAPABILITIES}::text[])`;
}

function fixtureSql(personPrefix: string, employmentPrefix: string, count: number) {
  if (!/^[0-9a-f-]{24}$/.test(personPrefix) || !/^[0-9a-f-]{24}$/.test(employmentPrefix) || !Number.isSafeInteger(count))
    throw new RangeError('Invalid fictional fixture identity');
  return `select n,
      ('${personPrefix}'||lpad(n::text,12,'0'))::uuid as person_id,
      ('${employmentPrefix}'||lpad(n::text,12,'0'))::uuid as employment_id,
      case when n%10<4 then 1 when n%10<7 then 2 when n%10<9 then 3 else 4 end as company_index,
      (date '2016-01-05' + ((n*37)%3950))::date as hired_on
    from generate_series(1,${count}) n`;
}

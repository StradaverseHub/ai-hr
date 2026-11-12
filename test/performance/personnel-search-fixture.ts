/** Fictional multi-company Personnel search workload (staging shape: 914 employments over 75 companies, and
 * larger). Seventy-plus companies in holding blocks, published dated organisation runs (mapping, restructure,
 * retag, a future run and an unpublished one), retained classifications, dated assignment history (earlier and
 * scheduled placements, cross-company and company-less placements, superseded corrections), future corrections
 * that move the dated company, terminated and voided staff, identity numbers, and three restricted actors read
 * through the real configurable Workforce access owners. Bulk rows are written by the migration owner (as in
 * personnel-scale-fixture.ts, in chunks and without the native write triggers: see below); every read under test runs as
 * ai_hr_app under RLS. All names, codes, numbers and
 * addresses are invented. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {publishWorkforceCapabilities} from '../../deploy/access/publish-workforce-capabilities';
import {adminCtx,owner,resetDb,seedBase,type Base} from '../harness';
import {predecessorStatement,restoreWorkforceCapabilityCatalogue} from './personnel-scale-fixture';

export type PersonnelSearchFixture = {
  base: Base; count: number; today: string;
  /** Every company, the seeded one first. Holdings are 1, 7, 13, ... (1-based); the rest belong to a holding. */
  companies: string[];
  /** Group-wide HR administrator. */
  admin: SessionContext;
  /** HR administrator of two holding blocks (and so their descendants), Workforce view denied on one child. */
  manager: SessionContext; managerCompanies: string[]; managerDenied: string;
  /** Capability-only viewer: workforce.view allowed on one holding block, denied on one of its children. */
  viewer: SessionContext; viewerCompanies: string[];
  /** A company whose HR administrators may not search identity numbers. */
  identityDenied: string;
};

const holding = (index: number) => Math.floor((index - 1) / 6) * 6 + 1;

/** Resets the worker database and seeds `count` fictional employments over `companies` companies. */
export async function seedPersonnelSearchFixture(p: {count: number; companies?: number; runs?: number}): Promise<PersonnelSearchFixture> {
  const count = p.count, total = p.companies ?? 76, extraRuns = p.runs ?? 4;
  if (!Number.isSafeInteger(count) || count < 50 || !Number.isSafeInteger(total) || total < 13 || !Number.isSafeInteger(extraRuns))
    throw new RangeError('Invalid fictional search fixture size');
  await resetDb();
  const base = await seedBase();
  const today = todayInKualaLumpur();
  const t = base.tenantId;
  // Companies 2..total; holdings (index%6=1) are top level, the others name their holding as parent.
  const extra = await owner.client<{id: string}[]>`insert into company(tenant_id,legal_name,company_label)
    select ${t}::uuid,'Fictional Company '||lpad(n::text,3,'0')||case when n%9=4 then ' Sdn. Bhd.' else ' Bhd' end,'FC'||n
    from generate_series(2,${total}) n order by n returning id`;
  const companies = [base.companyId, ...extra.map(row => row.id)];
  await owner.client`update company c set parent_company_id=(${companies}::uuid[])[(((x.n-1)/6)*6+1)]
    from unnest(${companies}::uuid[]) with ordinality as x(id,n) where c.id=x.id and x.n%6<>1`;
  // Per company: two departments, one position and two company-scoped Business Units.
  // Department d of company n is departments[(n-1)*2+d]; position of company n is positions[n].
  const departments = (await owner.client<{id: string}[]>`insert into department(tenant_id,company_id,name,label)
    select ${t}::uuid,x.id,'Fictional department '||x.n||'-'||d,case when d=2 then 'Dept '||x.n end
    from unnest(${companies}::uuid[]) with ordinality as x(id,n) cross join generate_series(1,2) d order by x.n,d returning id`).map(row => row.id);
  const positions = (await owner.client<{id: string}[]>`insert into position(tenant_id,company_id,title) select ${t}::uuid,x.id,'Fictional role '||x.n
    from unnest(${companies}::uuid[]) with ordinality as x(id,n) order by x.n returning id`).map(row => row.id);
  await owner.client`insert into business_unit(tenant_id,company_id,code,name)
    select ${t}::uuid,x.id,'BU'||x.n||'-'||u,'Fictional unit '||x.n||'-'||u
    from unnest(${companies}::uuid[]) with ordinality as x(id,n) cross join generate_series(1,2) u`;
  const grades = (await owner.client<{id: string}[]>`insert into job_grade(tenant_id,code,name,rank)
    select ${t}::uuid,code,'Grade '||code,ordinality from unnest(array['H','12','13','14']) with ordinality as g(code,ordinality)
    returning id`).map(row => row.id);

  const personPrefix = randomUUID().slice(0, 24), employmentPrefix = randomUUID().slice(0, 24);
  // Chunks of 2,500 employments, one transaction each: the native change counters on these tables (for example the
  // organisation source epoch) update one row per written row, and one transaction for 50,000 employments would make
  // every later update of that row walk an ever longer version chain.
  for (let low = 1; low <= count; low += CHUNK) {
    const rows = fixtureSql(personPrefix, employmentPrefix, low, Math.min(count, low + CHUNK - 1), total);
    await owner.client.begin(async tx => {
      // People, employments, placements and lines are bulk-written without the native write triggers (replica role,
      // this transaction only). Those triggers are guards (these rows are valid by construction), change counters
      // and work queues no Personnel reader reads; the replacement-holiday queue alone re-enqueues the whole tenant
      // per written row, which makes a 50,000-employment seed quadratic. None of them changes the written row here:
      // the import stamps and the organisation guard are no-ops before any import or published run exists.
      // Identity numbers (normalised by their trigger) and events keep every trigger.
      await tx.unsafe('set local session_replication_role = replica');
      // Mostly ASCII names, a few accented or non-Latin ones, and mixed-case e-mail.
      await tx.unsafe(`insert into person(id,tenant_id,full_name,primary_email)
        select f.person_id,$1::uuid,
          case when f.n%53=0 then (array['Zoë Ångström','ÇELİK Straße','Đặng Thị Lan','Σοφία Παπαδοπούλου','王 小明'])[1+(f.n/53)%5]||' '||f.n
            else (array['Aisyah','Ahmad','Siew Ling','Kumar','Mei Hua','Farid','Priya','Tan','Nurul','Daniel','Hafiz','Chong'])[1+(f.n*7)%12]
              ||' '||(array['Abdullah','Tan','Lim','Raj','Wong','Ismail','Chan','Kaur','Lee','Hassan','Ng','Fictional'])[1+(f.n*11)%12]
              ||case when f.n%9=0 then '' else ' '||(f.n%97)::text end end,
          case when f.n%29=0 then 'FICTIONAL.'||f.n||'@EXAMPLE.INVALID' when f.n%5=0 then 'Fictional.'||f.n||'@Example.Invalid' else 'fictional.'||f.n||'@example.invalid' end
        from (${rows}) f`, [t]);
      await tx.unsafe(`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,join_date,grade_id,
          confirmation_date,probation_end_date,terminated_on,resignation_date,last_working_date)
        select f.employment_id,$1::uuid,f.person_id,($2::uuid[])[f.company_index],
          case when f.n%41=0 then null when f.n%7=1 then 'FX.'||lpad(f.n::text,6,'0') when f.n%7=2 then 'fx_'||lpad(f.n::text,6,'0')
            when f.n%7=3 then 'FX '||lpad(f.n::text,6,'0') else 'FX-'||lpad(f.n::text,6,'0') end,
          f.hired_on,case when f.n%10<7 then f.hired_on + (f.n%30) end,($3::uuid[])[1+f.n%4],
          case when f.hired_on < $4::date - 200 and f.n%5<>4 then f.hired_on + 180 end,
          case when f.n%3=0 then f.hired_on + 90 end,
          case when f.n%13=3 then least($4::date - 1, f.hired_on + 400 + f.n%700) end,
          case when f.n%17=7 then greatest(f.hired_on, $4::date - 10) end,
          case when f.n%17=7 then $4::date + 20 end
        from (${rows}) f`, [t, companies, grades, today]);
      // Assignments, written before any organisation run exists (so the native recorder stays legacy):
      // an earlier placement (some in another company), the current one (some in another company or with no
      // company), a scheduled future placement in another company, and superseded corrections.
      await tx.unsafe(`insert into assignment(tenant_id,employment_id,company_id,department_id,position_id,business_unit_id,
          employment_type,valid_from,valid_to,superseded_at)
        with f as (select f.*, f.hired_on + 200 + f.n%400 as changed_on,
            case when f.n%25=0 then 1 + f.company_index%$3 else f.company_index end as earlier_company,
            case when f.n%40=7 then 1 + (f.company_index+2)%$3 else f.company_index end as current_company,
            1 + (f.company_index+4)%$3 as future_company
          from (${rows}) f)
        select $1::uuid,f.employment_id,($2::uuid[])[f.earlier_company],($5::uuid[])[(f.earlier_company-1)*2+1],($6::uuid[])[f.earlier_company],null::uuid,'full_time'::employment_type,
          f.hired_on,f.changed_on,null::timestamptz
        from f where f.changed_on < $4::date
        union all
        select $1::uuid,f.employment_id,case when f.n%45=4 then null else ($2::uuid[])[f.current_company] end,
          ($5::uuid[])[(f.current_company-1)*2+1+f.n%2],($6::uuid[])[f.current_company],null::uuid,
          (array['full_time','part_time','contract','intern']::employment_type[])[1 + (f.n%17)%4],
          case when f.changed_on < $4::date then f.changed_on else f.hired_on end,
          case when f.n%30=2 then greatest($4::date + 15, f.hired_on + 1) end,null::timestamptz
        from f
        union all
        select $1::uuid,f.employment_id,($2::uuid[])[f.future_company],($5::uuid[])[(f.future_company-1)*2+1],($6::uuid[])[f.future_company],null::uuid,'full_time'::employment_type,
          greatest($4::date + 15, f.hired_on + 1),null::date,null::timestamptz
        from f where f.n%30=2
        union all
        select $1::uuid,f.employment_id,($2::uuid[])[f.future_company],($5::uuid[])[(f.future_company-1)*2+2],null::uuid,null::uuid,'contract'::employment_type,
          case when f.changed_on < $4::date then f.changed_on else f.hired_on end,null::date,now() - interval '2 days'
        from f where f.n%10=1`, [t, companies, total, today, departments, positions]);
      // Administrative lines: one manager per block of 25 (in the same chunk), none for one in twelve.
      await tx.unsafe(`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from,valid_to,superseded_at)
        with f as (select * from (${rows}) f)
        select $1::uuid,f.employment_id,m.employment_id,'administrative'::reporting_line_type,f.hired_on,null::date,null::timestamptz
        from f join f m on m.n = ((f.n-1)/25)*25 + 1 where f.n%25<>1 and f.n%12<>5`, [t]);
      await tx.unsafe('set local session_replication_role = origin');
      // Identity numbers: twelve-digit NRICs for a third, passports for a seventh (some lower case).
      await tx.unsafe(`insert into employee_statutory_my(tenant_id,person_id,ic_number,passport_number)
        select $1::uuid,f.person_id,
          case when f.n%3=0 then lpad(((f.n*7919)%999999)::text,6,'0')||lpad((f.n%14+1)::text,2,'0')||lpad((f.n%10000)::text,4,'0') end,
          case when f.n%14=7 then 'p-'||lpad(f.n::text,8,'0') when f.n%7=0 then 'A'||lpad(f.n::text,8,'0') end
        from (${rows}) f where f.n%3=0 or f.n%7=0`, [t]);
      // Event history the dated-company resolver reads: hires, past corrections, and future corrections whose
      // "before" company is another company (the dated company until the correction takes effect).
      await tx.unsafe(`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload,occurred_at)
        select $1::uuid,'employment',f.employment_id,'employment.information.corrected','system'::actor_type,f.employment_id,
          jsonb_build_object('effectiveOn',(f.hired_on + 10)::text,'before',jsonb_build_object('companyId','')),f.hired_on::timestamptz + interval '10 days'
        from (${rows}) f where f.n%50=3
        union all
        select $1::uuid,'employment',f.employment_id,'employment.information.corrected','system'::actor_type,f.employment_id,
          jsonb_build_object('effectiveOn',($3::date + 30)::text,'before',jsonb_build_object('companyId',($2::uuid[])[1 + (f.company_index+1)%$4]::text)),now()
        from (${rows}) f where f.n%60=9`, [t, companies, today, total]);
    });
  }
  // Voided records (a reverted import) must never be searched.
  await owner.client`update employment set voided_at=now(),voided_by=${base.adminUserId}::uuid,
    void_reason='Fictional reverted import for the search fixture',voided_import_attempt_id=gen_random_uuid(),
    voided_employee_code=employee_code,employee_code=null
    where tenant_id=${t}::uuid and id::text like ${employmentPrefix + '%'} and right(id::text,12)::bigint%97=11`;

  // Published dated organisation runs, then retained classifications.
  const runs: {id: string; on: string; companies: number[]; kind: string; state: string}[] = [
    {id: randomUUID(), on: '2023-01-01', companies: range(1, Math.floor(total * 0.8)), kind: 'mapping', state: 'published'},
    {id: randomUUID(), on: shift(today, -100), companies: range(1, Math.floor(total / 2)), kind: 'restructure', state: 'published'},
    {id: randomUUID(), on: shift(today, -10), companies: [], kind: 'retag', state: 'published'},
    {id: randomUUID(), on: shift(today, 60), companies: range(1, total), kind: 'mapping', state: 'published'},
    {id: randomUUID(), on: shift(today, -5), companies: range(1, total), kind: 'mapping', state: 'approved'},
  ];
  for (let r = 0; r < extraRuns; r++)
    runs.push({id: randomUUID(), on: shift(today, -400 + r * 7), companies: range(1, total).filter(i => (i + r) % 3 === 0), kind: 'restructure', state: 'published'});
  for (const run of runs) {
    const ids = run.companies.map(i => companies[i - 1]);
    await owner.client`insert into company_organisation_run(id,tenant_id,kind,effective_on,state,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by,published_at)
      values(${run.id}::uuid,${t}::uuid,${run.kind},${run.on}::date,${run.state},${ids}::uuid[],${ids}::uuid[],
        ${JSON.stringify(ids.map(id => ({companyId: id})))}::jsonb,0,${'fixture-' + run.id},${base.adminUserId}::uuid,
        case when ${run.state}='published' then now() end)`;
    // Business Unit 1 or 2 of the company; the parent is the holding, except that the restructure moves some
    // children to the first holding and leaves a few companies without a unit (pending: not in the structure).
    await owner.client`insert into company_organisation_mapping(run_id,tenant_id,company_id,business_unit_id,parent_company_id)
      select ${run.id}::uuid,${t}::uuid,x.id,
        case when x.n%11=5 then null else (select b.id from business_unit b where b.company_id=x.id order by b.code offset (x.n+length(${run.kind}))%2 limit 1) end,
        case when x.n%6=1 then null when ${run.kind}='restructure' and x.n%4=0 then (${companies}::uuid[])[1] else (${companies}::uuid[])[(((x.n-1)/6)*6+1)] end
      from unnest(${companies}::uuid[]) with ordinality as x(id,n) where x.n=any(${run.companies}::int[])`;
  }
  // Retained classifications at the employment's own company: one from the first mapping (superseded where the
  // restructure later maps that company), one from the restructure with a different unit for some.
  await owner.client`insert into employment_organisation_classification(tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,trigger,actor_kind,idempotency_key)
    select e.tenant_id,e.id,e.company_id,r.effective_on,r.id,
      jsonb_build_object('companyId',e.company_id,'businessUnitId',m.business_unit_id,'parentCompanyId',m.parent_company_id,
        'businessGroupId',coalesce(m.parent_company_id,e.company_id),'mappingVersionId',r.id,'status',case when m.business_unit_id is null then 'pending' else 'ready' end,
        'reason',case when m.business_unit_id is null then 'Company not in Group structure' end),
      'publish','system',r.id::text||':'||e.id::text
    from employment e join company_organisation_mapping m on m.company_id=e.company_id and m.tenant_id=e.tenant_id
    join company_organisation_run r on r.id=m.run_id
    where e.tenant_id=${t}::uuid and r.state='published' and r.effective_on<=${today}::date and r.kind<>'retag'
      and right(e.id::text,12)::bigint%4=0`;

  await restoreWorkforceCapabilityCatalogue();
  await publishWorkforceCapabilities(owner.client);
  const holdings = range(1, total).filter(i => i % 6 === 1);
  const managerHoldings = [holdings[1], holdings[2]];
  const managerCompanies = range(1, total).filter(i => managerHoldings.includes(holding(i))).map(i => companies[i - 1]).sort();
  const managerDenied = companies[managerHoldings[0]];
  const viewerCompanies = range(1, total).filter(i => holding(i) === holdings[3]).map(i => companies[i - 1]).sort();
  const people = await owner.client<{personId: string; companyId: string}[]>`
    select distinct on (e.company_id) e.person_id as "personId",e.company_id as "companyId" from employment e
    where e.tenant_id=${t}::uuid and e.terminated_on is null and e.resignation_date is null and e.voided_at is null
      and e.company_id=any(${[companies[managerHoldings[0] - 1], companies[holdings[3] - 1]]}::uuid[])
    order by e.company_id,e.employee_code`;
  const personAt = (companyId: string) => people.find(row => row.companyId === companyId)!.personId;
  const [managerUser] = await owner.client<{id: string}[]>`insert into app_user(tenant_id,workos_user_id,person_id)
    values(${t}::uuid,${'fictional-search-manager-' + randomUUID()},${personAt(companies[managerHoldings[0] - 1])}::uuid) returning id`;
  await owner.client`insert into role_assignment(tenant_id,app_user_id,company_id,role) values
    (${t}::uuid,${managerUser.id}::uuid,${companies[managerHoldings[0] - 1]}::uuid,'employee'),
    (${t}::uuid,${managerUser.id}::uuid,${companies[managerHoldings[0] - 1]}::uuid,'hr_admin'),
    (${t}::uuid,${managerUser.id}::uuid,${companies[managerHoldings[1] - 1]}::uuid,'hr_admin')`;
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values
    (${t}::uuid,${managerUser.id}::uuid,'workforce.view',${managerDenied}::uuid,'deny')`;
  const [viewerUser] = await owner.client<{id: string}[]>`insert into app_user(tenant_id,workos_user_id,person_id)
    values(${t}::uuid,${'fictional-search-viewer-' + randomUUID()},${personAt(companies[holdings[3] - 1])}::uuid) returning id`;
  await owner.client`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${t}::uuid,${viewerUser.id}::uuid,${companies[holdings[3] - 1]}::uuid,'employee')`;
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values
    (${t}::uuid,${viewerUser.id}::uuid,'workforce.view',${companies[holdings[3] - 1]}::uuid,'allow'),
    (${t}::uuid,${viewerUser.id}::uuid,'workforce.view',${companies[holdings[3]]}::uuid,'deny')`;
  const identityDenied = companies[2];
  await owner.client`insert into payroll_permission_grant(tenant_id,company_id,role,permission_key,allowed)
    values(${t}::uuid,${identityDenied}::uuid,'hr_admin','report.read.identity',false)`;
  for (const table of ['person', 'employment', 'assignment', 'company', 'department', 'position', 'business_unit', 'app_user',
    'role_assignment', 'domain_event', 'access_user_override', 'employee_statutory_my', 'reporting_line', 'company_organisation_run',
    'company_organisation_mapping', 'employment_organisation_classification'])
    await owner.client.unsafe('analyze ' + table);

  const admin: SessionContext = {...adminCtx(base), grants: [{role: 'hr_admin', companyId: null}]};
  const manager: SessionContext = {
    tenantId: t, userId: managerUser.id, personId: personAt(companies[managerHoldings[0] - 1]), roles: ['employee', 'hr_admin'],
    grants: [{role: 'employee', companyId: companies[managerHoldings[0] - 1]}, {role: 'hr_admin', companyId: companies[managerHoldings[0] - 1]},
      {role: 'hr_admin', companyId: companies[managerHoldings[1] - 1]}],
    entitlements: admin.entitlements,
  };
  const viewer: SessionContext = {
    tenantId: t, userId: viewerUser.id, personId: personAt(companies[holdings[3] - 1]), roles: ['employee'],
    grants: [{role: 'employee', companyId: companies[holdings[3] - 1]}], entitlements: admin.entitlements,
  };
  const [counts] = await owner.client<{employments: number; companies: number}[]>`select
    (select count(*)::int from employment where tenant_id=${t}::uuid) as employments,
    (select count(*)::int from company where tenant_id=${t}::uuid) as companies`;
  expect(counts).toEqual({employments: count, companies: total});
  const [identity] = await withTenant(admin, tx => tx.execute<{role: string}>(sql`select current_user as role`));
  expect(identity.role).toBe('ai_hr_app');
  return {base, count, today, companies, admin, manager, managerCompanies, managerDenied, viewer, viewerCompanies, identityDenied};
}

const range = (from: number, to: number) => Array.from({length: Math.max(0, to - from + 1)}, (_, i) => from + i);
function shift(day: string, days: number) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const CHUNK = 2500;
function fixtureSql(personPrefix: string, employmentPrefix: string, low: number, high: number, companies: number) {
  if (!/^[0-9a-f-]{24}$/.test(personPrefix) || !/^[0-9a-f-]{24}$/.test(employmentPrefix) || !Number.isSafeInteger(low)
    || !Number.isSafeInteger(high) || !Number.isSafeInteger(companies))
    throw new RangeError('Invalid fictional fixture identity');
  return `select n,
      ('${personPrefix}'||lpad(n::text,12,'0'))::uuid as person_id,
      ('${employmentPrefix}'||lpad(n::text,12,'0'))::uuid as employment_id,
      case when n%10=0 then 1 else 1 + (n*7919)%${companies} end as company_index,
      (date '2016-01-05' + ((n*37)%3950))::date as hired_on
    from generate_series(${low},${high}) n`;
}

/** The functions migration 5121 adds; the bodies it replaces, as the migrations that installed them wrote them, with the
 * md5 of each body that 5121's predecessor check accepts. */
export const SEARCH_MAPPING_NEW_FUNCTIONS = [
  'app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[])', 'app._personnel_company_tags(uuid[],date)',
];
const FACTS = '5020_personnel_overview_facts';
const SEARCH_MAPPING_PREDECESSORS = [
  ['app._personnel_employment_tags(uuid[],date)', FACTS, '_personnel_employment_tags', '0f9f35c483c174b6bd3fda5223d6aa56'],
  ['app.personnel_overview_facts(date,uuid[])', FACTS, 'personnel_overview_facts', '5d195940a967b04b24270820d47c21d3'],
  ['app.personnel_overview_filter_fields(date,uuid[])', FACTS, 'personnel_overview_filter_fields', '25fa8aacafdd0f9751b03eafba3c2819'],
  ['app.personnel_filter_companies(uuid[],date)', FACTS, 'personnel_filter_companies', '7fc71e2d48517cabb7a2143e60d02dc4'],
  ['app.personnel_list_rows_for_ids(date,uuid[],uuid[])', FACTS, 'personnel_list_rows_for_ids', '0de9e7ea3615ff320921510a81d2ef13'],
  ['app.personnel_list_rows(date,uuid[])', '4001_personnel_employment_filter_projection', 'personnel_list_rows', 'c6d6b2e18d6beb6730932ad13e7bbcae'],
  ['app.personnel_private_search_bind()', FACTS, 'personnel_private_search_bind', '78204d88bb05143d49a7285cc6baafab'],
] as const;
const MAPPING_AT_DIGEST = 'dc4382976c3eec1dce402dc2145398c2';
const migration = (tag: string) => readFileSync(new URL('../../db/migrations/' + tag + '.sql', import.meta.url), 'utf8');
/** app.company_org_mapping_at as installed before 5121: the 2126 body with 3701's source-reader rewrite. */
function mappingAtPredecessor() {
  const text = migration('2126_company_organisation_tagging'), start = text.indexOf('CREATE FUNCTION app.company_org_mapping_at(');
  expect(start).toBeGreaterThan(0);
  const statement = text.slice(start, text.indexOf('$$;', text.indexOf('$$', start) + 2) + 3);
  return statement.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    .replace('company_organisation_run r', 'app.company_org_scope_run(NULL::uuid) r')
    .replace('company_organisation_mapping m', 'app.company_org_scope_mappings() m');
}

/** Return the database to the Personnel search and organisation owners exactly as they were before migration 5121
 * (each restored body is checked against the digest 5121 requires); the returned function re-applies 5121 itself. */
export async function installPreSearchMappingOwners(): Promise<() => Promise<void>> {
  const [installed] = await owner.client<{n: number}[]>`
    select count(*)::int as n from unnest(${SEARCH_MAPPING_NEW_FUNCTIONS}::text[]) name where to_regprocedure(name) is not null`;
  expect(installed.n, 'migration 5121 is applied before the oracle switch').toBe(SEARCH_MAPPING_NEW_FUNCTIONS.length);
  await owner.client.begin(async tx => {
    await tx.unsafe(mappingAtPredecessor()).simple();
    for (const [, tag, name] of SEARCH_MAPPING_PREDECESSORS) {
      const statement = predecessorStatement(tag, name);
      await tx.unsafe(statement.replace('CREATE FUNCTION app.' + name + '(', 'CREATE OR REPLACE FUNCTION app.' + name + '(')).simple();
    }
    for (const name of SEARCH_MAPPING_NEW_FUNCTIONS) await tx.unsafe(`drop function ${name}`);
  });
  const digests = await owner.client<{signature: string; digest: string}[]>`select x.signature,md5(p.prosrc) as digest
    from unnest(${[...SEARCH_MAPPING_PREDECESSORS.map(([signature]) => signature), 'app.company_org_mapping_at(date)']}::text[]) as x(signature)
    join pg_proc p on p.oid=to_regprocedure(x.signature) order by 1`;
  expect(Object.fromEntries(digests.map(row => [row.signature, row.digest]))).toEqual(Object.fromEntries(
    [...SEARCH_MAPPING_PREDECESSORS.map(([signature, , , digest]) => [signature, digest]), ['app.company_org_mapping_at(date)', MAPPING_AT_DIGEST]]));
  return async () => {
    await owner.client.unsafe(migration('5121_personnel_search_set_mapping')).simple();
  };
}

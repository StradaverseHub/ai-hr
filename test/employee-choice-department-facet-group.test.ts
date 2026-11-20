import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql,type SQL} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {assignment,company,department,employment,person,roleAssignment} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {firstWitnessDepartmentFacet} from './performance/employee-choice-department-pair-probe';

type Facet = {companyId:string;company:string;departmentId:string;department:string};
type Population = {companyIds:string[];terminatedAfter:string};

// Experimental statement only. Membership stays on the current Employment company,
// and both the source rows and the label catalog are read under native RLS.
function representedDepartments(context:SessionContext,population:Population) {
  const companyIds='{'+population.companyIds.join(',')+'}';
  return sql`
    with authorized_members as materialized (
      select e.id,e.company_id from employment e
      join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
      where e.tenant_id=${context.tenantId}::uuid and e.company_id=any(${companyIds}::uuid[])
        and (e.terminated_on is null or e.terminated_on>${population.terminatedAfter}::date)
    ), represented_department_pairs as materialized (
      select m.company_id,a.department_id from authorized_members m
      join assignment a on a.employment_id=m.id and a.tenant_id=${context.tenantId}::uuid
      where a.valid_to is null and a.superseded_at is null and a.department_id is not null
      group by m.company_id,a.department_id
    )
    select c.id as "companyId",c.legal_name as company,d.id as "departmentId",d.name as department
    from represented_department_pairs r
    join company c on c.id=r.company_id and c.tenant_id=${context.tenantId}::uuid
    join department d on d.id=r.department_id and d.tenant_id=${context.tenantId}::uuid
    order by c.id,d.id`;
}

beforeAll(migrateTestDb);
afterAll(closeAll);

it('compares first-witness and represented department reads across a 70-company group',async()=>{
  await resetDb();
  const base=await seedBase();
  const group=adminCtx(base);
  const scopedId=await createAppUser(base.tenantId,null,'hr_admin');
  await owner.db.update(roleAssignment).set({companyId:base.companyId}).where(eq(roleAssignment.appUserId,scopedId));
  const scoped={...group,userId:scopedId,grants:[{role:'hr_admin' as const,companyId:base.companyId}]};
  const extra=Array.from({length:69},(_,index)=>({id:randomUUID(),legalName:'Fictional company '+(index+1),departmentId:randomUUID()}));
  const companies=[{id:base.companyId,departmentId:base.deptA},...extra];
  const employees=Array.from({length:1000},(_,index)=>({
    id:randomUUID(),personId:randomUUID(),company:companies[index%companies.length],index,
  }));
  await owner.client.begin(async raw=>{
    await raw`insert into company (id,tenant_id,legal_name)
      select c.id,${base.tenantId}::uuid,c.name
      from unnest(${extra.map(row=>row.id)}::uuid[],${extra.map(row=>row.legalName)}::text[]) c(id,name)`;
    await raw`insert into department (id,tenant_id,company_id,name)
      select d.id,${base.tenantId}::uuid,d.company_id,'Fictional represented department'
      from unnest(${extra.map(row=>row.departmentId)}::uuid[],${extra.map(row=>row.id)}::uuid[]) d(id,company_id)`;
  });
  for(let offset=0;offset<employees.length;offset+=250){
    const batch=employees.slice(offset,offset+250);
    await owner.db.insert(person).values(batch.map(row=>({
      id:row.personId,tenantId:base.tenantId,fullName:'Fictional employee '+row.index,
    })));
    await owner.db.insert(employment).values(batch.map(row=>({
      id:row.id,tenantId:base.tenantId,personId:row.personId,companyId:row.company.id,hiredOn:'2020-01-01',
    })));
    await owner.db.insert(assignment).values(batch.map(row=>({
      tenantId:base.tenantId,employmentId:row.id,companyId:row.company.id,departmentId:row.company.departmentId,
      validFrom:'2020-01-01',employmentType:'full_time' as const,
    })));
  }
  await owner.client`analyze public.company,public.department,public.person,public.employment,public.assignment`;
  const allIds=companies.map(row=>row.id);
  const scenarios=[
    {name:'group-all',context:group,ids:allIds,expected:companies},
    {name:'group-single-company',context:group,ids:[base.companyId],expected:companies.slice(0,1)},
    {name:'company-hr',context:scoped,ids:allIds,expected:companies.slice(0,1)},
  ];
  const report=[];
  const terminatedAfter=todayInKualaLumpur();
  for(const scenario of scenarios){
    const population={companyIds:scenario.ids,terminatedAfter};
    const firstWitness=firstWitnessDepartmentFacet(base.tenantId,population);
    const represented=representedDepartments(scenario.context,population);
    await withTenant(scenario.context,async tx=>{
      const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
      expect(identity.role).toBe('ai_hr_app');
      const measure=async(statement:SQL)=>{
        const started=performance.now();
        const rows=await tx.execute<Facet>(statement);
        const elapsedMs=Math.round(performance.now()-started);
        return {rows:rows.map(({companyId,company,departmentId,department})=>({companyId,company,departmentId,department})),elapsedMs};
      };
      const observations=[];
      for(const statement of [firstWitness,represented,represented,firstWitness])observations.push(await measure(statement));
      const expected=scenario.expected.map(row=>({companyId:row.id,departmentId:row.departmentId})).sort((a,b)=>a.companyId.localeCompare(b.companyId));
      for(const observation of observations) {
        expect(observation.rows.map(({companyId,departmentId})=>({companyId,departmentId}))).toEqual(expected);
        expect(observation.rows).toEqual(observations[0].rows);
      }
      report.push({scenario:scenario.name,rows:expected.length,firstWitnessMs:[observations[0].elapsedMs,observations[3].elapsedMs],
        representedMs:[observations[1].elapsedMs,observations[2].elapsedMs]});
    },{readOnlySnapshot:true});
  }
  const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(evidence)writeFileSync(join(evidence,'employee-department-facet-group.json'),JSON.stringify({
    source:process.env.AIHR_CI_HEAD,companies:70,employments:1000,observations:report,
  },null,2));
},90000);

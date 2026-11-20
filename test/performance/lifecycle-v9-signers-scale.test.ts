import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {joinerPageSections} from '../../lib/onboarding-page-access';
import type {Config} from '../../lib/onboarding-model';
import {onboardingContext,onboardingSaveConfig,v9Setup,v9Workspace} from '../../packs/lifecycle/service';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

function previousSigners(ctx:SessionContext,companyIds:readonly string[]) {
  return withTenant(ctx,async tx=>{
    const scopes=['combined','onb','off'] as const;
    const results=[];
    for(const scope of scopes){
      results.push(Object.fromEntries(await Promise.all(companyIds.map(async companyId=>{
        const [config]=await tx.execute<{data:Config}>(sql`select data from lc_onboarding_config where tenant_id=${ctx.tenantId}::uuid`);
        if(!config)return [companyId,[]] as const;
        const users=await tx.execute<{id:string}>(sql`
          select u.id from app_user u where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null
          and not app.login_blocked(u.id) and exists(select 1 from role_assignment r where r.tenant_id=u.tenant_id
          and r.app_user_id=u.id and r.role in ('super_admin','hr_admin') and (r.company_id is null or r.company_id=${companyId}::uuid)) order by u.id`);
        const eligible=users.filter(({id})=>{
          const sections=joinerPageSections(config.data,id);
          const onb=config.data.access.onboarding.includes(id)||(sections?.actions==='allowed'&&sections.hr==='view');
          const off=config.data.access.offboarding.includes(id);
          return scope==='onb'?onb:scope==='off'?off:onb||off;
        });
        return [companyId,eligible.map(user=>user.id)] as const;
      }))));
    }
    return results;
  });
}

it('preserves every company and module signatory at group scale',async()=>{
  await resetDb();
  const base=await seedBase();
  await setModule(base.tenantId,'lifecycle','active');
  const group=await entitledCtx(base);
  await v9Setup(group);
  const companies=await owner.client<{id:string}[]>`
    insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Fictional title company '||n
    from generate_series(1,71) n returning id`;
  const ids=[base.companyId,...companies.map(company=>company.id)];
  const population=await owner.client<{company_id:string;person_id:string}[]>`
    with people as (
      insert into person (tenant_id,full_name,primary_email)
      select ${base.tenantId}::uuid,'Fictional company staff '||n,'lifecycle-signers-'||n||'@example.invalid'
      from generate_series(1,1152) n returning id
    )
    insert into employment (tenant_id,person_id,company_id,hired_on)
    select ${base.tenantId}::uuid,p.id,c.id,'2024-01-01'::date
    from (select id,row_number() over(order by id) n from people) p
    join unnest(${ids}::uuid[]) with ordinality c(id,n) on c.n=1+(p.n-1)%72
    returning company_id,person_id`;
  expect(population).toHaveLength(1152);
  const [onboarding,offboarding]=await Promise.all(ids.slice(0,2).map(async companyId=>{
    const person=population.find(row=>row.company_id===companyId)!;
    const userId=await createAppUser(base.tenantId,person.person_id,'hr_admin');
    await owner.client`update role_assignment set company_id=${companyId}::uuid where app_user_id=${userId}::uuid`;
    return {userId,personId:person.person_id,companyId};
  }));
  const {config,revision}=await onboardingContext(group);
  config.access.onboarding.push(onboarding.userId);
  config.access.offboarding.push(offboarding.userId);
  await onboardingSaveConfig(group,revision,config);
  const company:SessionContext={...group,userId:onboarding.userId,personId:onboarding.personId,grants:[{role:'hr_admin',companyId:onboarding.companyId}]};
  for(const [label,actor,scope] of [['group',group,ids],['company',company,[onboarding.companyId]]] as const){
    const started=performance.now();
    const [combined,onb,off]=await previousSigners(actor,scope);
    const previousSignersMs=Math.round(performance.now()-started);
    const workspaceStarted=performance.now();
    const {options}=await v9Workspace(actor);
    const workspaceMs=Math.round(performance.now()-workspaceStarted);
    expect(options.companies.map(row=>row.id).sort()).toEqual([...scope].sort());
    expect(options.signatoryCandidates).toEqual(combined);
    expect(options.signatoryCandidatesByModule).toEqual({onb,off});
    expect(onb[onboarding.companyId]).toContain(onboarding.userId);
    expect(off[onboarding.companyId]).not.toContain(onboarding.userId);
    if(label==='group')expect(off[offboarding.companyId]).toContain(offboarding.userId);
    console.info('Lifecycle signatory comparison',{label,companies:scope.length,previousSignersMs,workspaceMs});
  }
},90000);

/** Board item 0af23331 (SCALE rule 3). The accepted-TP3 opening read at the shape of a real group: 70 companies and
 * 1,000 employments, one statement, ordered rows, counts derived from the fixture constants (never from the reader), and
 * equivalence with the previous 20 November reader for the employees it used to default. Fictional fixtures only. */
import {afterAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {owner,resetDb,seedBase,setModule,entitledCtx,closeAll} from './harness';
import {readTaxOpeningRowsTx,resolveTaxOpeningRow} from '../core/payroll-tax-opening';
afterAll(closeAll);

const YEAR=2026,N=1000,COMPANIES=70;
const hasForm=(n:number)=>n%5===0,hasProjection=(n:number)=>n%7===0,declaredYes=(n:number)=>n%3===0,declaredNo=(n:number)=>n%11===0&&!declaredYes(n);
const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
/** The 20 November reader, kept here verbatim as the equivalence baseline for the defaulted set. */
async function previousNoTp3OpeningTx(tx:Tx,ctx:SessionContext,year:number,employmentIds:string[]):Promise<Set<string>>{
 const rows=await tx.execute<{id:string}>(sql`
  select e.id from employment e
  where e.tenant_id=${ctx.tenantId}::uuid and e.id=any(${uuidArray(employmentIds)})
    and app.can_see_person(e.person_id) is true and app.can_admin_payroll_for(e.company_id) is true
    and app.can_admin_employment(e.id) is true
    and not exists(select 1 from employee_tp3 t where t.tenant_id=e.tenant_id and t.person_id=e.person_id and t.assessment_year=${year})
    and not exists(select 1 from employee_statutory_my s where s.tenant_id=e.tenant_id and s.person_id=e.person_id and s.tp3_year=${year})
    and (select a.had_previous_employer from payroll_tp3_previous_employer_answer a
      where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.person_id=e.person_id and a.assessment_year=${year}
      order by a.answered_at desc,a.id desc limit 1) is not true`);
 return new Set(rows.map(row=>row.id));
}

it('reads 1,000 openings across 70 companies in one ordered statement with exact sources and no scope expansion',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'TP3 shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 const companies=[b.companyId,...others.map(company=>company.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'TP3 shape person '||n,'tp3-shape-'||n||'@fixture.invalid' from generate_series(1,${N}::integer)n returning id),ranked as(select id,row_number()over(order by id)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${b.tenantId}::uuid,id,(${companies}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'TP3-SCALE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const fixture=await owner.client<{id:string;personId:string;companyId:string;code:string}[]>`select id,person_id as "personId",company_id as "companyId",employee_code as code from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'TP3-SCALE-%' order by id`;
 expect(fixture).toHaveLength(N);
 const nOf=new Map(fixture.map(row=>[row.id,Number(row.code.slice(10))]));
 const payload={form:'tp3-2026',sectionC:{c2:{amount:1000,subItems:{i:1000}}},sectionD:{}};
 await owner.client`insert into employee_tp3(tenant_id,person_id,assessment_year,payload) select ${b.tenantId}::uuid,person_id,${YEAR},${JSON.stringify(payload)}::jsonb from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'TP3-SCALE-%' and substr(employee_code,11)::int%5=0`;
 // A draft is never an input, even for someone with no accepted TP3.
 await owner.client`insert into employee_tp3_draft(tenant_id,person_id,employment_id,assessment_year,previous_employers,payload) select ${b.tenantId}::uuid,person_id,id,${YEAR},'[]'::jsonb,${JSON.stringify(payload)}::jsonb from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'TP3-SCALE-%' and substr(employee_code,11)::int%2=1`;
 await owner.client`insert into employee_statutory_my(tenant_id,person_id,tp3_year,tp3_exemption_used) select ${b.tenantId}::uuid,person_id,${YEAR},'{"PCB_TRA_BUSINESS":250}'::jsonb from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'TP3-SCALE-%' and substr(employee_code,11)::int%7=0
  on conflict (person_id) do update set tp3_year=excluded.tp3_year,tp3_exemption_used=excluded.tp3_exemption_used`;
 await owner.client`insert into payroll_tp3_previous_employer_answer(tenant_id,person_id,employment_id,assessment_year,had_previous_employer,answered_by_user_id) select ${b.tenantId}::uuid,person_id,id,${YEAR},substr(employee_code,11)::int%3=0,${ctx.userId!}::uuid from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'TP3-SCALE-%' and (substr(employee_code,11)::int%3=0 or substr(employee_code,11)::int%11=0)`;

 const ids=fixture.map(row=>row.id);
 let statements=0;const started=performance.now();
 const rows=await withTenant(ctx,tx=>readTaxOpeningRowsTx(new Proxy(tx,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return key==='execute'?(...args:unknown[])=>{statements++;return (value as (...a:unknown[])=>unknown).apply(target,args);}:value;}}),ctx,YEAR,ids));
 console.info('TP3_OPENING_SCALE_DIAGNOSTIC',JSON.stringify({elapsedMs:Math.round(performance.now()-started),statements,rows:rows.size}));
 expect(statements).toBe(1);
 expect([...rows.keys()]).toEqual(ids);
 const expected={form:0,projection:0,none:0,declared:0};
 for(let n=1;n<=N;n++){if(hasForm(n))expected.form++;else if(hasProjection(n))expected.projection++;else{expected.none++;if(declaredYes(n))expected.declared++;}}
 const resolved=[...rows.values()].map(row=>({n:nOf.get(row.id)!,result:resolveTaxOpeningRow(row)}));
 const actual={form:0,projection:0,none:0,declared:0};
 for(const {n,result} of resolved){
  expect(result.state).toBe('resolved');if(result.state!=='resolved')continue;
  const opening=result.opening;
  if(opening.tp3?.kind==='form'){actual.form++;expect(opening.used).toEqual({PCB_TRA_BUSINESS:1000});expect(hasForm(n)).toBe(true);}
  else if(opening.tp3?.kind==='statutory_projection'){actual.projection++;expect(opening.used).toEqual({PCB_TRA_BUSINESS:250});expect(hasProjection(n)&&!hasForm(n)).toBe(true);}
  else{actual.none++;expect(opening).toEqual({source:'no_accepted_tp3',used:{},previousEmployerDeclared:declaredYes(n)});if(opening.previousEmployerDeclared)actual.declared++;expect(declaredNo(n)?opening.previousEmployerDeclared:false).toBe(false);}
 }
 expect(actual).toEqual(expected);
 expect(expected).toEqual({form:200,projection:114,none:686,declared:expected.declared});

 // Equivalence with the previous reader: exactly the employees it defaulted are the RM0, undeclared rows now.
 const previous=await withTenant(ctx,tx=>previousNoTp3OpeningTx(tx,ctx,YEAR,ids));
 const zeroUndeclared=new Set(resolved.filter(({result})=>result.state==='resolved'&&result.opening.source==='no_accepted_tp3'&&!result.opening.previousEmployerDeclared).map(({n})=>fixture.find(row=>nOf.get(row.id)===n)!.id));
 expect([...zeroUndeclared].sort()).toEqual([...previous].sort());

 // One company: same rows and values for that company's subset.
 const oneCompany=fixture.filter(row=>row.companyId===b.companyId).map(row=>row.id);
 const scoped=await withTenant(ctx,tx=>readTaxOpeningRowsTx(tx,ctx,YEAR,oneCompany));
 expect([...scoped.values()]).toEqual(oneCompany.map(id=>rows.get(id)));

 // A payroll administrator of one company gets no TP3 data for the other 69 companies: access is insufficient there.
 const narrow={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const narrowed=await withTenant(narrow,tx=>readTaxOpeningRowsTx(tx,narrow,YEAR,ids));
 const foreignIds=fixture.filter(row=>row.companyId!==b.companyId).map(row=>row.id);
 expect(foreignIds).toHaveLength(N-oneCompany.length);
 // Hidden by row security or visible without authority: either way no TP3 figure, answer or projection is returned.
 for(const id of foreignIds){const row=narrowed.get(id);if(row)expect(row).toMatchObject({access:false,tp3Id:null,tp3Payload:null,projection:false,declared:null});expect(resolveTaxOpeningRow(row).state).toBe('access_insufficient');}
 for(const id of oneCompany.filter(id=>narrowed.has(id)))expect(narrowed.get(id)).toEqual(rows.get(id));
},180000);

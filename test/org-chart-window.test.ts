import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import {orgChartData} from '../core/read';
import {orgChartEntry,orgChartWindow,OrgWindowUnavailableError,ORG_FULL_GRAPH_LIMIT,type OrgWindowRequest} from '../core/org-chart-window';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);


/** Frozen previous entry: threshold resolution and the initial explorer root request used two
 * independently authorized transactions. Keep this as a test-only timing and DTO oracle. */
async function previousOrgChartEntry(actor:SessionContext,scope:string[]|undefined){
 const selected=await withTenant(actor,async tx=>{
  await tx.execute(sql`set transaction read only`);
  await lockAccessConfigurationReadTx(tx,actor.tenantId);
  const [proof]=await tx.execute<{allowed:boolean}>(sql`select app.current_user_id()=${actor.userId??null}::uuid and app.principal_snapshot_current() as allowed`);
  if(!actor.userId||proof?.allowed!==true)throw new OrgWindowUnavailableError('principal');
  const [size]=await tx.execute<{large:boolean}>(sql`with visibility as materialized(select unnest(app.visible_employment_ids()) as id),
   live as materialized(
    select e.id,e.tenant_id,e.person_id,e.employee_code,e.company_id
    from public.employment e join visibility v on v.id=e.id
    where e.tenant_id=app.current_tenant_id() and e.terminated_on is null
   ),native_edges as not materialized(
    select r.id,r.manager_employment_id as manager_id,r.subordinate_employment_id as subordinate_id,r.line_type::text as type
    from public.reporting_line r join live manager on manager.id=r.manager_employment_id join live subordinate on subordinate.id=r.subordinate_employment_id
    where r.valid_to is null and r.superseded_at is null and r.line_type<>'delegate'
   )
   select case when (select count(*) from(select id from live limit ${ORG_FULL_GRAPH_LIMIT+1})people)>${ORG_FULL_GRAPH_LIMIT} then true
    else (select count(*) from(select id from native_edges limit ${ORG_FULL_GRAPH_LIMIT+1})edges)>${ORG_FULL_GRAPH_LIMIT} end as large`);
  if(size.large)return {mode:'explorer' as const};
  return {mode:'full' as const,...await orgChartData(actor,scope,tx)};
 });
 if(selected.mode==='full')return selected;
 return {mode:'explorer' as const,initial:await orgChartWindow(actor,scope,{view:'roots'})};
}

async function compareEntries(actor:SessionContext,scope:string[]|undefined,mode:'full'|'explorer'){
 const first=await previousOrgChartEntry(actor,scope);expect(first.mode).toBe(mode);
 const records:{phase:string;elapsedMs:number;bytes:number}[]=[];
 for(const phase of ['original','candidate','candidate-warm','restored']){
  const started=performance.now();
  const result=phase.startsWith('candidate')?await orgChartEntry(actor,scope):await previousOrgChartEntry(actor,scope);
  records.push({phase,elapsedMs:performance.now()-started,bytes:Buffer.byteLength(JSON.stringify(result))});
  expect(result).toEqual(first);
 }
 return records;
}

it('preserves the complete authorized graph through bounded roots, branches, literal search and all connector types',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const [companyB]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Other chart company'}).returning();
 const [departmentB]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:companyB.id,name:'Other department'}).returning();
 const people=Array.from({length:500},(_,index)=>({index,id:randomUUID(),personId:randomUUID(),companyId:index<250?b.companyId:companyB.id,
  departmentId:index<250?b.deptA:departmentB.id,name:index===249?'Literal %_ name':'Org Person '+String(index).padStart(4,'0')}));
 await owner.db.insert(s.person).values(people.map(p=>({id:p.personId,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.personId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(people.map(p=>({id:p.id,tenantId:b.tenantId,personId:p.personId,companyId:p.companyId,hiredOn:'2020-01-01',employeeCode:'ORG'+p.index})));
 await owner.db.insert(s.assignment).values(people.map(p=>({tenantId:b.tenantId,employmentId:p.id,companyId:p.companyId,departmentId:p.departmentId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 const lines:{manager:number;subordinate:number;type:'administrative'|'functional'|'project'|'dotted'|'delegate';validFrom:string}[]=[];
 for(let n=60;n<250;n++)lines.push({manager:n<160?1:0,subordinate:n,type:'administrative',validFrom:'2020-01-01'});
 for(let n=310;n<500;n++)lines.push({manager:250,subordinate:n,type:'administrative',validFrom:'2020-01-01'});
 lines.push({manager:0,subordinate:250,type:'administrative',validFrom:'2020-01-01'},
  {manager:0,subordinate:251,type:'functional',validFrom:'2020-01-01'},
  {manager:0,subordinate:252,type:'project',validFrom:'2020-01-01'},
  {manager:0,subordinate:253,type:'dotted',validFrom:'2020-01-01'},
  {manager:5,subordinate:400,type:'delegate',validFrom:'2020-01-01'},
  {manager:0,subordinate:10,type:'administrative',validFrom:'2099-01-01'});
 await owner.db.insert(s.reportingLine).values(lines.map(line=>({tenantId:b.tenantId,managerEmploymentId:people[line.manager].id,subordinateEmploymentId:people[line.subordinate].id,lineType:line.type,validFrom:line.validFrom})));
 const userCtx=async(index:number,role:'employee'|'manager'|'hr_admin',companyId:string|null=null):Promise<SessionContext>=>{
  const userId=await createAppUser(b.tenantId,people[index].personId,role);
  await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
  return {...ctx,userId,personId:people[index].personId,roles:[role],grants:[{role,companyId}]};
 };
 const companyHR=await userCtx(0,'hr_admin',b.companyId),manager=await userCtx(1,'manager'),employee=await userCtx(4,'employee');
 const sorted=(ids:string[])=>[...ids].sort();
 const collected=async(actor:SessionContext,scope:string[]|undefined,request:OrgWindowRequest)=>{
  const rows:Awaited<ReturnType<typeof orgChartWindow>>['items']=[];let after:string|undefined,iterations=0,totalItems=-1,totalPeople=-1;
  do{
   const page=await orgChartWindow(actor,scope,{...request,after});
   expect(page.items.length).toBeLessThanOrEqual(50);expect(page.pageSize).toBe(50);
   expect(page.totalItems).toBe(totalItems<0?page.totalItems:totalItems);expect(page.totalPeople).toBe(totalPeople<0?page.totalPeople:totalPeople);
   totalItems=page.totalItems;totalPeople=page.totalPeople;rows.push(...page.items);after=page.nextCursor??undefined;
   expect(++iterations).toBeLessThan(50);
  }while(after);
  expect(rows).toHaveLength(totalItems);expect(new Set(rows.map(row=>row.key)).size).toBe(rows.length);
  return {rows,totalItems,totalPeople};
 };
 const cases=[{name:'group',actor:ctx,scope:undefined},{name:'company filter',actor:ctx,scope:[b.companyId]},
  {name:'company HR',actor:companyHR,scope:undefined},{name:'manager',actor:manager,scope:undefined},{name:'employee',actor:employee,scope:undefined}];
 for(const value of cases){
  const legacy=await orgChartData(value.actor,value.scope),byId=new Map(legacy.employees.map(node=>[node.employmentId,node]));
  const parented=new Set(legacy.edges.filter(edge=>edge.type==='administrative'&&byId.has(edge.manager)&&byId.has(edge.subordinate)).map(edge=>edge.subordinate));
  const roots=await collected(value.actor,value.scope,{view:'roots'});
  expect(roots.totalPeople).toBe(byId.size);expect(sorted(roots.rows.map(row=>row.node!.employmentId))).toEqual(sorted([...byId.keys()].filter(id=>!parented.has(id))));
  for(const row of roots.rows){const{assignmentCount,...node}=row.node!;expect(assignmentCount).toBe(1);expect(node).toEqual(byId.get(node.employmentId));}
  const all=await collected(value.actor,value.scope,{view:'search',q:''});expect(sorted(all.rows.map(row=>row.node!.employmentId))).toEqual(sorted([...byId.keys()]));
  for(const q of ['person 00','finance','%_']){
   const found=await collected(value.actor,value.scope,{view:'search',q});
   const expected=legacy.employees.filter(node=>(node.name+' '+(node.role??'')+' '+(node.department??'')).toLowerCase().includes(q));
   expect(sorted(found.rows.map(row=>row.node!.employmentId))).toEqual(sorted([...new Set(expected.map(node=>node.employmentId))]));
  }
  const focus=legacy.employees.find(node=>node.employmentId===people[0].id)??legacy.employees[0];
  if(!focus)continue;
  for(const view of ['children','parents']as const){
   const branch=await collected(value.actor,value.scope,{view,focusId:focus.employmentId});
   const expected=legacy.edges.filter(edge=>edge.type==='administrative'&&(view==='children'?edge.manager:edge.subordinate)===focus.employmentId)
    .map(edge=>view==='children'?edge.subordinate:edge.manager).filter(id=>byId.has(id));
   expect(sorted(branch.rows.map(row=>row.node!.employmentId))).toEqual(sorted([...new Set(expected)]));
  }
  const connections=await collected(value.actor,value.scope,{view:'connections',focusId:focus.employmentId});
  const expected=legacy.edges.filter(edge=>edge.manager===focus.employmentId||edge.subordinate===focus.employmentId)
   .map(edge=>[edge.manager===focus.employmentId?'outgoing':'incoming',edge.type,edge.manager===focus.employmentId?edge.subordinate:edge.manager].join(':')).sort();
  expect(connections.rows.map(row=>[row.direction,row.type,row.otherEmploymentId].join(':')).sort()).toEqual(expected);
  for(const row of connections.rows)expect(row.inSelectedScope).toBe(byId.has(row.otherEmploymentId));
 }
 const scopedConnections=await collected(ctx,[b.companyId],{view:'connections',focusId:people[0].id});
 expect(scopedConnections.rows.some(row=>row.otherEmploymentId===people[250].id&&row.node===null&&row.inSelectedScope===false)).toBe(true);
 expect(new Set(scopedConnections.rows.map(row=>row.type))).toEqual(new Set(['administrative','functional','project','dotted']));
 const [smallCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Single selected chart company'}).returning();
 const [smallPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Single selected person',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:smallPerson.id,companyId:smallCompany.id,hiredOn:'2020-01-01'});
 const smallSelection=await orgChartEntry(ctx,[smallCompany.id]);expect(smallSelection.mode).toBe('explorer');
 if(smallSelection.mode==='explorer')expect(smallSelection.initial.totalPeople).toBe(1);
 // An authorized but foreign-company node must not become a selectable focus outside the people scope.
 await expect(orgChartWindow(ctx,[b.companyId],{view:'children',focusId:people[250].id})).rejects.toMatchObject({reason:'focus'});
 await expect(orgChartWindow(ctx,undefined,{view:'roots',after:randomUUID()})).rejects.toMatchObject({reason:'cursor'});
 await expect(orgChartWindow({...ctx,userId:randomUUID()},undefined,{view:'roots'})).rejects.toBeInstanceOf(OrgWindowUnavailableError);
 await expect(orgChartWindow({...ctx,tenantId:foreign.tenantId},undefined,{view:'roots'})).rejects.toBeInstanceOf(OrgWindowUnavailableError);
 await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,employee.userId!));
 await expect(orgChartWindow(employee,undefined,{view:'roots'})).rejects.toMatchObject({reason:'principal'});
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,companyHR.userId!));
 await expect(orgChartWindow(companyHR,undefined,{view:'roots'})).rejects.toMatchObject({reason:'principal'});
 await owner.db.update(s.employment).set({terminatedOn:'2024-01-01'}).where(eq(s.employment.id,people[200].id));
 const legacy=await orgChartData(ctx),branch=await collected(ctx,undefined,{view:'children',focusId:people[0].id});
 expect(branch.rows.some(row=>row.node!.employmentId===people[200].id)).toBe(false);
 expect(sorted(branch.rows.map(row=>row.node!.employmentId))).toEqual(sorted(legacy.edges.filter(edge=>edge.type==='administrative'&&edge.manager===people[0].id).map(edge=>edge.subordinate)));
},600000);

it('keeps a small authorized graph exactly on the legacy full-tree path',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),people=Array.from({length:80},(_,index)=>({id:randomUUID(),personId:randomUUID(),name:'Small chart '+index}));
 await owner.db.insert(s.person).values(people.map(p=>({id:p.personId,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.personId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(people.map(p=>({id:p.id,tenantId:b.tenantId,personId:p.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.reportingLine).values(people.slice(1).map(p=>({tenantId:b.tenantId,managerEmploymentId:people[0].id,subordinateEmploymentId:p.id,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 expect(await orgChartEntry(ctx,[b.companyId])).toEqual({mode:'full',...await orgChartData(ctx,[b.companyId])});
 const small=await compareEntries(ctx,[b.companyId],'full');
 // Fewer than 201 people can still have >200 caller-wide structural edges.
 await owner.db.insert(s.reportingLine).values(people.slice(1).flatMap(p=>(['functional','project'] as const).map(lineType=>({
  tenantId:b.tenantId,managerEmploymentId:people[0].id,subordinateEmploymentId:p.id,lineType,validFrom:'2020-01-01',
 }))));
 const edgeThreshold=await orgChartEntry(ctx,[b.companyId]);
 expect(edgeThreshold.mode).toBe('explorer');
 if(edgeThreshold.mode==='explorer'){
  expect(edgeThreshold.initial.totalPeople).toBe(80);expect(edgeThreshold.initial.totalItems).toBe(1);
 }
 expect(edgeThreshold).toEqual(await previousOrgChartEntry(ctx,[b.companyId]));
 await expect(orgChartEntry({...ctx,userId:randomUUID()},[b.companyId])).rejects.toMatchObject({reason:'principal'});
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'org-chart-entry-small.json'),
  JSON.stringify({people:80,smallEdges:79,largeEdges:237,legacyModeParity:true,edgeThresholdParity:true,small},null,2));
});

it('keeps the response bounded while all five thousand direct reports remain reachable',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),count=5000,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
 await owner.client`insert into person(id,tenant_id,full_name,primary_email)
  select(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Bounded Org Person '||lpad(n::text,6,'0'),(${personPrefix}||n::text)||'@example.invalid'from generate_series(0,${count}::integer)n`;
 await owner.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
  select(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'ORG'||n,'2020-01-01'::date from generate_series(0,${count}::integer)n`;
 const root=employmentPrefix+'000000000000';
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from)
  select ${b.tenantId}::uuid,${root}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,'administrative','2020-01-01'::date from generate_series(1,${count}::integer)n`;
 for(const table of ['person','employment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const measurements:{phase:string;elapsedMs:number;bytes:number;people:number;edges?:number}[]=[];
 for(const phase of ['original','candidate','candidate-warm','restored']){
  const began=performance.now();
  if(phase==='original'||phase==='restored'){
   const graph=await orgChartData(ctx);expect(graph.employees).toHaveLength(count+1);expect(graph.edges).toHaveLength(count);
   measurements.push({phase,elapsedMs:performance.now()-began,bytes:Buffer.byteLength(JSON.stringify(graph)),people:graph.employees.length,edges:graph.edges.length});
  }else{
   const window=await orgChartWindow(ctx,undefined,{view:'children',focusId:root});expect(window.totalPeople).toBe(count+1);expect(window.totalItems).toBe(count);expect(window.items).toHaveLength(50);expect(window.nextCursor).not.toBeNull();
   expect(window.items[0].node!.name).toBe('Bounded Org Person 000001');
   expect(window.items.at(-1)!.node!.name).toBe('Bounded Org Person 000050');
   measurements.push({phase,elapsedMs:performance.now()-began,bytes:Buffer.byteLength(JSON.stringify(window)),people:window.items.length});
  }
 }
 const entry=await compareEntries(ctx,[b.companyId],'explorer');
 const entryRatio=Math.max(entry[1].elapsedMs,entry[2].elapsedMs)/Math.min(entry[0].elapsedMs,entry[3].elapsedMs);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'org-chart-entry-large.json'),
  JSON.stringify({kind:'ORG_CHART_ACTUAL_ENTRY_NATIVE_COMPONENT_ONLY',releaseEligible:false,people:count+1,edges:count,
   exactEntryDto:true,entry,entryRatio,limitations:'Native 5001-person initial entry; no browser, million-row or500-user evidence.'},null,2));
 const last=employmentPrefix+String(count-50).padStart(12,'0');
 const tail=await orgChartWindow(ctx,undefined,{view:'children',focusId:root,after:last});expect(tail.items).toHaveLength(50);expect(tail.nextCursor).toBeNull();expect(tail.items.at(-1)!.node!.name).toBe('Bounded Org Person 005000');
 const report={kind:'NATIVE_BOUNDED_ORG_WINDOW_NOT_BROWSER_OR500_ACCEPTANCE',releaseEligible:false,employees:count+1,directReports:count,measurements,tailReachable:true,
  nativeAuthority:'fresh principal, native visibility owner plus existing RLS; no authorization/data cache',limitations:'First bounded contract experiment; small graph page and large graph explorer/browser integration not implemented.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'org-chart-window.json'),JSON.stringify(report,null,2));
 expect(Math.max(measurements[1].bytes,measurements[2].bytes)).toBeLessThan(measurements[0].bytes*.1);
 expect(entryRatio,'single native large entry should improve ≥20% against the faster previous entry').toBeLessThan(.8);
},600000);

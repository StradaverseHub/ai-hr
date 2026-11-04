import {and,asc,desc,eq,gt,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {assignment,businessUnit,company,department,employment,orgChartRoot,person,position,reportingLine} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {projectOrgChart,type OrgChartEmployee,type OrgChartEdge,type OrgChartFilter} from '../lib/org-chart-model';
import {assertWorkforceEmploymentTx} from './workforce-access';

export function orgChartDate(value?:string){const date=value||todayInKualaLumpur();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Invalid organisation effective date');return date;}
export async function orgChartSnapshot(ctx:SessionContext,p:{companyIds:string[];filter?:Partial<OrgChartFilter>}){
 const asOf=orgChartDate(p.filter?.asOf);const filter={...p.filter,asOf};
 if(!p.companyIds.length)return {employees:[],edges:[],issues:[],options:[],asOf,canManage:false};
 return withTenant(ctx,async tx=>{
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);
  // Employment RLS and the explicit graph predicate both remain in force; a selected filter never
  // widens access. Company at the effective dated assignment owns historical transfers.
  const rows=await tx.select({employmentId:employment.id,personId:person.id,name:person.fullName,employeeCode:employment.employeeCode,
   role:position.title,department:department.name,departmentId:assignment.departmentId,businessUnit:businessUnit.name,businessUnitId:assignment.businessUnitId,
   companyId:sql<string>`coalesce(${assignment.companyId},${employment.companyId})`,company:company.legalName,employmentType:assignment.employmentType,
   terminatedOn:employment.terminatedOn,confirmationDate:employment.confirmationDate,probationEndDate:employment.probationEndDate,tenderResignationDate:employment.tenderResignationDate,
   hasPhoto:sql<boolean>`exists(select 1 from person_photo photo where photo.person_id=${person.id})`,validFrom:assignment.validFrom,
  }).from(employment).innerJoin(person,eq(person.id,employment.personId))
   .leftJoin(assignment,and(eq(assignment.employmentId,employment.id),isNull(assignment.supersededAt),lte(assignment.validFrom,asOf),or(isNull(assignment.validTo),gt(assignment.validTo,asOf))))
   .innerJoin(company,sql`${company.id}=coalesce(${assignment.companyId},${employment.companyId})`)
   .leftJoin(department,eq(department.id,assignment.departmentId)).leftJoin(businessUnit,eq(businessUnit.id,assignment.businessUnitId)).leftJoin(position,eq(position.id,assignment.positionId))
   .where(and(inArray(sql`coalesce(${assignment.companyId},${employment.companyId})`,p.companyIds),lte(employment.hiredOn,asOf),sql`app.can_see_employment(${employment.id})`))
   .orderBy(asc(person.fullName),desc(assignment.validFrom),asc(employment.id));
  const roots=await tx.select({employmentId:orgChartRoot.employmentId}).from(orgChartRoot).where(and(lte(orgChartRoot.validFrom,asOf),or(isNull(orgChartRoot.validTo),gt(orgChartRoot.validTo,asOf))));
  const top=new Set(roots.map(r=>r.employmentId));
  const seen=new Set<string>();const all:OrgChartEmployee[]=rows.filter(row=>{if(seen.has(row.employmentId))return false;seen.add(row.employmentId);return true;}).map(row=>({
   employmentId:row.employmentId,personId:row.personId,name:row.name,employeeCode:row.employeeCode,role:row.role,department:row.department,departmentId:row.departmentId,
   businessUnit:row.businessUnit,businessUnitId:row.businessUnitId,companyId:row.companyId,company:row.company,employmentType:row.employmentType,
   status:row.terminatedOn&&row.terminatedOn<=asOf?'inactive':row.tenderResignationDate&&row.tenderResignationDate<=asOf?'notice':row.employmentType==='full_time'&&row.probationEndDate&&(!row.confirmationDate||row.confirmationDate>asOf)?'probation':'active',
   topLevel:top.has(row.employmentId),canOpenProfile:true,photoUrl:row.hasPhoto?`/personnel/photo/${row.personId}`:null,
  }));
  const edges=await tx.select({manager:reportingLine.managerEmploymentId,subordinate:reportingLine.subordinateEmploymentId,type:reportingLine.lineType}).from(reportingLine)
   .where(and(isNull(reportingLine.supersededAt),lte(reportingLine.validFrom,asOf),or(isNull(reportingLine.validTo),gt(reportingLine.validTo,asOf)),sql`${reportingLine.lineType}<>'delegate'`,sql`app.can_see_employment(${reportingLine.subordinateEmploymentId})`))
   .orderBy(asc(reportingLine.id));
  const result=projectOrgChart({employees:all,edges:edges as OrgChartEdge[],filter});
  // Termination closes structural links. Retain the specific vacancy annotation only when the
  // latest ended link ended on its permitted manager's actual cessation date; never invent a parent.
  const ended=await tx.select({subordinate:reportingLine.subordinateEmploymentId,manager:reportingLine.managerEmploymentId,validTo:reportingLine.validTo})
   .from(reportingLine).where(and(eq(reportingLine.lineType,'administrative'),isNull(reportingLine.supersededAt),lte(reportingLine.validTo,asOf),sql`app.can_see_employment(${reportingLine.subordinateEmploymentId})`)).orderBy(desc(reportingLine.validTo),desc(reportingLine.validFrom),asc(reportingLine.id));
  const latestEnded=new Map<string,typeof ended[number]>();for(const edge of ended)if(!latestEnded.has(edge.subordinate))latestEnded.set(edge.subordinate,edge);
  for(const employee of result.employees){if(employee.managerState!=='missing')continue;const previous=latestEnded.get(employee.employmentId);const manager=previous?all.find(e=>e.employmentId===previous.manager):undefined;const original=previous?rows.find(e=>e.employmentId===previous.manager):undefined;
   if(previous&&manager?.status==='inactive'&&previous.validTo===original?.terminatedOn){employee.managerState='inactive';employee.managerName=manager.name;const issue=result.issues.find(i=>i.employmentId===employee.employmentId);if(issue)issue.code='inactive';}
  }
  const counts=new Map<string,number>();for(const edge of result.edges)if(edge.type==='administrative')counts.set(edge.manager,(counts.get(edge.manager)??0)+1);
  for(const employee of result.employees)employee.directReportCount=counts.get(employee.employmentId)??0;
  const options=[...new Map(all.filter(e=>e.status!=='inactive').map(({companyId,company,businessUnitId,businessUnit,departmentId,department})=>[JSON.stringify([companyId,businessUnitId,departmentId]),{companyId,company,businessUnitId,businessUnit,departmentId,department}])).values()];
  return {...result,options,asOf,canManage:authority?.allowed===true};
 });
}
export class OrgChartRootError extends Error {constructor(public readonly code:'hasSuperior'|'inactive'){super(code);this.name='OrgChartRootError';}}
export async function setOrgChartRoot(ctx:SessionContext,p:{employmentId:string;validFrom:string;enabled:boolean}){
 const date=orgChartDate(p.validFrom);
 return withTenant(ctx,async tx=>{
  await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);if(!authority?.allowed)throw new Error('Organisation maintenance is unavailable');
  const [employee]=await tx.select({id:employment.id,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn}).from(employment).where(eq(employment.id,p.employmentId)).for('update');
  if(!employee||employee.hiredOn>date||employee.terminatedOn&&employee.terminatedOn<=date)throw new OrgChartRootError('inactive');
  if(p.enabled){const [superior]=await tx.select({id:reportingLine.id}).from(reportingLine).where(and(eq(reportingLine.subordinateEmploymentId,p.employmentId),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.supersededAt),sql`daterange(${reportingLine.validFrom},${reportingLine.validTo},'[)') && daterange(${date}::date,NULL,'[)')`)).limit(1);if(superior)throw new OrgChartRootError('hasSuperior');}
  const open=await tx.select().from(orgChartRoot).where(and(eq(orgChartRoot.employmentId,p.employmentId),or(isNull(orgChartRoot.validTo),gt(orgChartRoot.validTo,date)))).orderBy(asc(orgChartRoot.validFrom));
  for(const root of open)await tx.update(orgChartRoot).set({validTo:date<root.validFrom?root.validFrom:date}).where(eq(orgChartRoot.id,root.id));
  if(p.enabled)await tx.insert(orgChartRoot).values({tenantId:ctx.tenantId,employmentId:p.employmentId,validFrom:date});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'org-chart-root',aggregateId:p.employmentId,eventType:'org-chart-root.changed',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{validFrom:date,previous:open.map(root=>({id:root.id,validFrom:root.validFrom})),topLevel:p.enabled}});
 });
}
export async function recordOrgChartExport(ctx:SessionContext,p:{companyIds:string[];asOf:string;employmentIds:string[];filters:unknown;layout:unknown}){
 return withTenant(ctx,async tx=>{const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);if(!authority?.allowed)throw new Error('Organisation export is unavailable');
  const visible=p.employmentIds.length?await tx.select({id:employment.id}).from(employment).where(and(inArray(employment.id,p.employmentIds),sql`app.can_see_employment(${employment.id})`)):[];
  if(visible.length!==p.employmentIds.length)throw new Error('Organisation export scope changed');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'org-chart',aggregateId:ctx.tenantId,eventType:'org-chart.exported',actor:actorOf(ctx),payload:p});
 });
}

/** The actual exporting actor's own recorded name; an unlinked login retains its auditable id. */
export function orgChartActorName(ctx:SessionContext){return withTenant(ctx,async tx=>{if(ctx.personId){const [actor]=await tx.select({name:person.fullName}).from(person).where(eq(person.id,ctx.personId)).limit(1);if(actor)return actor.name;}return ctx.userId??'HR';});}

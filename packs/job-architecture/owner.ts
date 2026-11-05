import 'server-only';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appendEvent,actorOf} from '../../db/events';
import {lockAccessConfigurationTx} from '../../core/access-configuration-lock';
import {labelUsableByCompany,lockLabelCriteriaTx} from '../../core/system-labels';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {architectureGrade,ArchitectureError,assertIndependentChecker,validateArchitectureCatalogue,validatePositionMappings,scanArchitectureOutliers,type ArchitectureCatalogue,type ArchitecturePosition,type ArchitectureEmployee,type PositionMapping} from './model';
const uuid=z.uuid(),reason=z.string().trim().min(10).max(4000);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Proposal={id:string;company_id:string|null;kind:'catalogue'|'positions'|'outlier_resolution';base_revision:number;payload:Record<string,unknown>;reason:string;created_by:string;created_at:string;status:'pending'|'approved'|'rejected';checked_by:string|null};
export type ArchitectureOutlierRow={id:string;fingerprint:string;company_ids:string[];detail:ReturnType<typeof scanArchitectureOutliers>[number];state:'new'|'open'|'partial'|'resolved';owner_id:string|null;due_on:string|null;resolution:string|null;revision:number;resolved_by:string|null;checked_by:string|null};
async function tenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>){if(!ctx.userId)throw new ArchitectureError('forbidden','Sign in to continue.');return withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return fn(tx);});}
async function authority(tx:Tx,companyId:string|null,operation:'view'|'propose'|'check'){
 const [r]=await tx.execute<{ok:boolean}>(sql`select app.job_architecture_can(${companyId}::uuid,${operation}) as ok`);if(!r?.ok)throw new ArchitectureError('forbidden','You do not have access to this architecture action.');
}
async function writeLock(tx:Tx,ctx:SessionContext){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId},2200))`);}
async function event(tx:Tx,ctx:SessionContext,id:string,action:string,payload:unknown){await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'job-architecture',aggregateId:id,eventType:'job-architecture.'+action,actor:actorOf(ctx),payload});}
async function catalogueTx(tx:Tx,ctx:SessionContext){
 const [r]=await tx.execute<{revision:number;catalogue:ArchitectureCatalogue}>(sql`select revision,catalogue from job_architecture_catalogue_revision where tenant_id=${ctx.tenantId}::uuid order by revision desc limit 1`);
 return r??{revision:0,catalogue:{nodes:[],ladder:[]}};
}
async function gradeBindings(tx:Tx,ctx:SessionContext,pairs:readonly {gradeId:string;code:string}[]){
 for(const p of pairs){const [g]=await tx.execute<{code:string}>(sql`select code from job_grade where id=${p.gradeId}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null for share`);
  if(!g||architectureGrade(g.code)!==p.code)throw new ArchitectureError('invalid','Grade identity must match an active Personnel grade.');}
}
async function workspaceTx(tx:Tx,ctx:SessionContext,companyFilter?:string){
 await authority(tx,null,'view');if(companyFilter)uuid.parse(companyFilter);
 const catalogue=await catalogueTx(tx,ctx);
 const companies=await tx.execute<{id:string;name:string;canPropose:boolean;canCheck:boolean}>(sql`select id,legal_name as name,app.job_architecture_can(id,'propose') as "canPropose",app.job_architecture_can(id,'check') as "canCheck" from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.job_architecture_can(id,'view') ${companyFilter?sql`and id=${companyFilter}::uuid`:sql``} order by legal_name,id`);
 const ids=companies.map(c=>c.id),idList=ids.length?sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`):sql`null::uuid`;
 const positions=await tx.execute<{id:string;title:string;companyId:string;company:string;mapping:PositionMapping|null;revision:number}>(sql`
  select p.id,p.title,c.id as "companyId",c.legal_name as company,m.mapping,coalesce(m.revision,0) as revision
  from company c join position p on p.tenant_id=c.tenant_id and p.archived_at is null and (p.is_global or exists(select 1 from label_company_assignment a where a.tenant_id=p.tenant_id and a.label_kind='position' and a.label_id=p.id and a.company_id=c.id))
  left join lateral(select mapping,revision from job_architecture_position_revision m where m.tenant_id=p.tenant_id and m.position_id=p.id and m.company_id=c.id order by revision desc limit 1)m on true
  where c.tenant_id=${ctx.tenantId}::uuid and c.id in (${idList}) order by c.legal_name,p.title,p.id`);
 const today=todayInKualaLumpur();
 const employees=await tx.execute<{id:string;companyId:string;positionId:string|null;gradeCode:string|null}>(sql`
  select e.id,e.company_id as "companyId",a.position_id as "positionId",g.code as "gradeCode" from employment e
  left join job_grade g on g.id=e.grade_id and g.tenant_id=e.tenant_id
  left join lateral(select a.position_id from assignment a where a.employment_id=e.id and a.tenant_id=e.tenant_id and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>=${today}::date) order by a.valid_from desc,a.id desc limit 1)a on true
  where e.tenant_id=${ctx.tenantId}::uuid and e.company_id in (${idList}) and app.access_workforce_employment(e.id,'workforce.view')`);
 const checkedEmployees:ArchitectureEmployee[]=employees.map(e=>({...e,grade:e.gradeCode?architectureGrade(e.gradeCode):null}));
 const proposals=await tx.execute<Proposal>(sql`select id,company_id,kind,base_revision,payload,reason,created_by,created_at::text,status,checked_by from job_architecture_proposal where tenant_id=${ctx.tenantId}::uuid and status='pending' ${companyFilter?sql`and (company_id=${companyFilter}::uuid or company_id is null)`:sql``} order by created_at,id limit 200`);
 const outliers=await tx.execute<ArchitectureOutlierRow>(sql`select id,fingerprint,company_ids,detail,state,owner_id,due_on::text,resolution,revision,resolved_by,checked_by from job_architecture_outlier where tenant_id=${ctx.tenantId}::uuid ${companyFilter?sql`and (${companyFilter}::uuid=any(company_ids) or cardinality(company_ids)=0)`:sql``} order by case when state='resolved' then 1 else 0 end,detected_at,id limit 1000`);
 const grades=await tx.execute<{id:string;code:string;name:string;description:string|null}>(sql`select id,code,name,description from job_grade where tenant_id=${ctx.tenantId}::uuid and archived_at is null order by rank,code,id`);
 const [global]=await tx.execute<{canPropose:boolean;canCheck:boolean;canConfigure:boolean}>(sql`select app.job_architecture_can(null,'propose') as "canPropose",app.job_architecture_can(null,'check') as "canCheck",app.is_group_admin() as "canConfigure"`);
 return {catalogue,companies,positions,employees:checkedEmployees,proposals,outliers,grades:grades.filter(g=>architectureGrade(g.code)),global,sourceDigest:digest({catalogue,positions:positions.map(p=>[p.companyId,p.id,p.revision])})};
}
export function architectureWorkspace(ctx:SessionContext,companyId?:string){return tenant(ctx,tx=>workspaceTx(tx,ctx,companyId));}
export async function proposeArchitectureCatalogue(ctx:SessionContext,input:{catalogue:unknown;baseRevision:number;reason:string}){
 const catalogue=validateArchitectureCatalogue(input.catalogue),why=reason.parse(input.reason),base=z.number().int().nonnegative().parse(input.baseRevision);
 return tenant(ctx,async tx=>{await authority(tx,null,'propose');await writeLock(tx,ctx);const current=await catalogueTx(tx,ctx);if(current.revision!==base)throw new ArchitectureError('changed','The catalogue changed. Reopen the latest version.');
  await gradeBindings(tx,ctx,catalogue.ladder);const id=randomUUID();await tx.execute(sql`insert into job_architecture_proposal(id,tenant_id,kind,base_revision,payload,reason,created_by) values(${id}::uuid,${ctx.tenantId}::uuid,'catalogue',${base},${JSON.stringify({catalogue})}::jsonb,${why},${ctx.userId}::uuid)`);await event(tx,ctx,id,'catalogue.proposed',{baseRevision:base});return id;});
}
async function validateMappingsTx(tx:Tx,ctx:SessionContext,companyId:string,mappings:PositionMapping[]){
 await lockLabelCriteriaTx(tx,ctx.tenantId);await gradeBindings(tx,ctx,mappings.map(m=>({gradeId:m.gradeId,code:m.grade})));
 for(const m of mappings){if(m.companyId!==companyId||!await labelUsableByCompany(tx,ctx.tenantId,'position',m.positionId,companyId))throw new ArchitectureError('invalid','Choose a position available to this company.');
  if(m.businessUnitId&&!await labelUsableByCompany(tx,ctx.tenantId,'business_unit',m.businessUnitId,companyId))throw new ArchitectureError('invalid','Choose a Business unit available to this company.');
  if(m.reportsToPositionId&&!await labelUsableByCompany(tx,ctx.tenantId,'position',m.reportsToPositionId,companyId))throw new ArchitectureError('invalid','Choose an available reporting position.');}
}
export function proposeArchitecturePositions(ctx:SessionContext,input:{companyId:string;catalogueRevision:number;sourceDigest:string;mappings:unknown;reason:string}){
 const companyId=uuid.parse(input.companyId),why=reason.parse(input.reason);
 return tenant(ctx,async tx=>{await authority(tx,companyId,'propose');await writeLock(tx,ctx);const w=await workspaceTx(tx,ctx,companyId);if(w.catalogue.revision!==input.catalogueRevision||w.sourceDigest!==input.sourceDigest)throw new ArchitectureError('changed','Positions or their source records changed. Preview the mapping again.');
  const proposed=validatePositionMappings(input.mappings,w.catalogue.catalogue.nodes);await validateMappingsTx(tx,ctx,companyId,proposed);
  const merged=new Map(w.positions.flatMap(p=>p.mapping?[[p.id,p.mapping] as const]:[]));for(const p of proposed)merged.set(p.positionId,p);validatePositionMappings([...merged.values()],w.catalogue.catalogue.nodes);
  const id=randomUUID(),payload={mappings:proposed,sourceDigest:w.sourceDigest};await tx.execute(sql`insert into job_architecture_proposal(id,tenant_id,company_id,kind,base_revision,payload,reason,created_by) values(${id}::uuid,${ctx.tenantId}::uuid,${companyId}::uuid,'positions',${w.catalogue.revision},${JSON.stringify(payload)}::jsonb,${why},${ctx.userId}::uuid)`);await event(tx,ctx,id,'positions.proposed',{companyId,count:proposed.length,catalogueRevision:w.catalogue.revision});return id;});
}
export function decideArchitectureProposal(ctx:SessionContext,input:{id:string;approve:boolean}){
 const id=uuid.parse(input.id),approve=z.boolean().parse(input.approve);
 return tenant(ctx,async tx=>{await writeLock(tx,ctx);const [p]=await tx.execute<Proposal>(sql`select * from job_architecture_proposal where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);if(!p||p.status!=='pending')throw new ArchitectureError('changed','This proposal is no longer waiting for a decision.');
  await authority(tx,p.company_id,'check');assertIndependentChecker(ctx.userId!,[p.created_by]);
  const c=await catalogueTx(tx,ctx);let catalogue:ArchitectureCatalogue|undefined,mappings:PositionMapping[]=[];
  if(approve&&p.kind==='catalogue'){if(p.base_revision!==c.revision)throw new ArchitectureError('changed','A newer catalogue has already been approved.');catalogue=validateArchitectureCatalogue(p.payload.catalogue);await gradeBindings(tx,ctx,catalogue.ladder);}
  if(approve&&p.kind==='positions'){const w=await workspaceTx(tx,ctx,p.company_id!);if(w.catalogue.revision!==p.base_revision||w.sourceDigest!==p.payload.sourceDigest)throw new ArchitectureError('changed','Mapping source changed; ask for a fresh proposal.');mappings=validatePositionMappings(p.payload.mappings,c.catalogue.nodes);await validateMappingsTx(tx,ctx,p.company_id!,mappings);}
  await tx.execute(sql`update job_architecture_proposal set status=${approve?'approved':'rejected'},checked_by=${ctx.userId}::uuid,checked_at=now() where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if(catalogue)await tx.execute(sql`insert into job_architecture_catalogue_revision(tenant_id,revision,catalogue,proposal_id,proposed_by,checked_by) values(${ctx.tenantId}::uuid,${c.revision+1},${JSON.stringify(catalogue)}::jsonb,${id}::uuid,${p.created_by}::uuid,${ctx.userId}::uuid)`);
  for(const m of mappings)await tx.execute(sql`insert into job_architecture_position_revision(tenant_id,company_id,position_id,revision,catalogue_revision,mapping,proposal_id,proposed_by,checked_by) select ${ctx.tenantId}::uuid,${m.companyId}::uuid,${m.positionId}::uuid,coalesce(max(revision),0)+1,${c.revision},${JSON.stringify(m)}::jsonb,${id}::uuid,${p.created_by}::uuid,${ctx.userId}::uuid from job_architecture_position_revision where tenant_id=${ctx.tenantId}::uuid and company_id=${m.companyId}::uuid and position_id=${m.positionId}::uuid`);
  if(approve&&p.kind==='outlier_resolution')await resolveOutlierTx(tx,ctx,p);
  await event(tx,ctx,id,approve?'proposal.approved':'proposal.rejected',{kind:p.kind,companyId:p.company_id});
 });
}
export function scanArchitecture(ctx:SessionContext){return tenant(ctx,async tx=>{await authority(tx,null,'propose');await writeLock(tx,ctx);const w=await workspaceTx(tx,ctx);const found=scanArchitectureOutliers(w.catalogue.catalogue.nodes,w.positions as ArchitecturePosition[],w.employees);
 for(const o of found)await tx.execute(sql`insert into job_architecture_outlier(tenant_id,fingerprint,company_ids,detail) values(${ctx.tenantId}::uuid,${o.fingerprint},${o.companyIds}::uuid[],${JSON.stringify(o)}::jsonb) on conflict(tenant_id,fingerprint) do update set last_seen_at=now(),detail=excluded.detail,state=case when job_architecture_outlier.state='resolved' then 'open' else job_architecture_outlier.state end,revision=job_architecture_outlier.revision+case when job_architecture_outlier.state='resolved' then 1 else 0 end`);
 const id=randomUUID();await event(tx,ctx,id,'outliers.scanned',{count:found.length,sourceDigest:w.sourceDigest});return found.length;});}
export function proposeOutlierResolution(ctx:SessionContext,input:{id:string;revision:number;reason:string}){const id=uuid.parse(input.id),why=reason.parse(input.reason);return tenant(ctx,async tx=>{await authority(tx,null,'propose');const [o]=await tx.execute<ArchitectureOutlierRow>(sql`select * from job_architecture_outlier where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid for share`);if(!o||o.revision!==input.revision||o.state==='resolved')throw new ArchitectureError('changed','Reopen the current outlier.');for(const c of o.company_ids)await authority(tx,c,'propose');const p=randomUUID();await tx.execute(sql`insert into job_architecture_proposal(id,tenant_id,kind,base_revision,payload,reason,created_by) values(${p}::uuid,${ctx.tenantId}::uuid,'outlier_resolution',${o.revision},${JSON.stringify({outlierId:id})}::jsonb,${why},${ctx.userId}::uuid)`);await event(tx,ctx,p,'outlier.resolution.proposed',{outlierId:id});return p;});}
async function resolveOutlierTx(tx:Tx,ctx:SessionContext,p:Proposal){const id=uuid.parse(p.payload.outlierId);const [o]=await tx.execute<ArchitectureOutlierRow>(sql`select * from job_architecture_outlier where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);if(!o||o.revision!==p.base_revision)throw new ArchitectureError('changed','The outlier changed.');for(const c of o.company_ids)await authority(tx,c,'check');const w=await workspaceTx(tx,ctx);if(scanArchitectureOutliers(w.catalogue.catalogue.nodes,w.positions as ArchitecturePosition[],w.employees).some(f=>f.fingerprint===o.fingerprint))throw new ArchitectureError('invalid','Apply the underlying fix before confirming resolution.');await tx.execute(sql`update job_architecture_outlier set state='resolved',resolution=${p.reason},resolved_by=${p.created_by}::uuid,checked_by=${ctx.userId}::uuid,revision=revision+1 where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);}
export function assignArchitectureSeat(ctx:SessionContext,raw:unknown){const p=z.object({userId:uuid,companyId:uuid.nullable(),role:z.enum(['group_rewards','org_design','pbp']),validFrom:z.iso.date(),validTo:z.iso.date().nullable()}).strict().parse(raw);return tenant(ctx,async tx=>{const [a]=await tx.execute<{ok:boolean}>(sql`select app.is_group_admin() as ok`);if(!a?.ok)throw new ArchitectureError('forbidden','Only a group administrator can assign architecture seats.');if(p.validTo&&p.validTo<p.validFrom)throw new ArchitectureError('invalid','End date must follow start date.');const [r]=await tx.execute<{id:string}>(sql`insert into job_architecture_seat(tenant_id,user_id,company_id,role,valid_from,valid_to,created_by) values(${ctx.tenantId}::uuid,${p.userId}::uuid,${p.companyId}::uuid,${p.role},${p.validFrom}::date,${p.validTo}::date,${ctx.userId}::uuid) returning id`);await event(tx,ctx,r.id,'seat.assigned',{userId:p.userId,companyId:p.companyId,role:p.role});return r.id;});}

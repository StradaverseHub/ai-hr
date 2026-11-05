/** Bounded, fresh Org exploration. The legacy full-chart reader remains unchanged. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';

export const ORG_WINDOW_SIZE=50;
export type OrgRelation='administrative'|'functional'|'project'|'dotted';
export type OrgWindowView='roots'|'children'|'parents'|'search'|'connections';
export type OrgWindowNode={employmentId:string;name:string;employeeCode:string|null;role:string|null;department:string|null;assignmentCount:number};
export type OrgWindowItem={key:string;node:OrgWindowNode|null;otherEmploymentId:string;type:OrgRelation|null;direction:'outgoing'|'incoming'|null;inSelectedScope:boolean};
export type OrgWindowRequest={view:OrgWindowView;focusId?:string;after?:string;q?:string};
export type OrgWindow={version:1;view:OrgWindowView;focus:OrgWindowNode|null;items:OrgWindowItem[];totalPeople:number;totalItems:number;pageSize:number;nextCursor:string|null};
export class OrgWindowUnavailableError extends Error{
 constructor(public reason:'principal'|'focus'|'cursor'){super('The organization view is no longer available.');this.name='OrgWindowUnavailableError';}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const views=new Set(['roots','children','parents','search','connections']);

function orgGraphRelations(scopeWhere:SQL):SQL{return sql`visibility as materialized(select unnest(app.visible_employment_ids()) as id),
   live as materialized(
    select e.id,e.tenant_id,e.person_id,e.employee_code,e.company_id
    from public.employment e join visibility v on v.id=e.id
    where e.tenant_id=app.current_tenant_id() and e.terminated_on is null
   ),eligible as materialized(
    select l.*,p.full_name as name from live l join public.person p on p.id=l.person_id and p.tenant_id=l.tenant_id where ${scopeWhere}
   ),
   native_edges as not materialized(
    select r.id,r.manager_employment_id as manager_id,r.subordinate_employment_id as subordinate_id,r.line_type::text as type
    from public.reporting_line r join live manager on manager.id=r.manager_employment_id join live subordinate on subordinate.id=r.subordinate_employment_id
    where r.valid_to is null and r.superseded_at is null and r.line_type<>'delegate'
   )`;}

async function withOrgChartReadTx<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>):Promise<T>{
 const actor={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 return withTenant(actor,async tx=>{
  await tx.execute(sql`set transaction read only`);
  await lockAccessConfigurationReadTx(tx,actor.tenantId);
  const [proof]=await tx.execute<{allowed:boolean}>(sql`select app.current_user_id()=${actor.userId??null}::uuid and app.principal_snapshot_current() as allowed`);
  if(!actor.userId||proof?.allowed!==true)throw new OrgWindowUnavailableError('principal');
  return read(tx);
 });
}

export const ORG_FULL_GRAPH_LIMIT=200;
/** Small graphs keep the existing full-tree data/UI. Never load a full graph merely because
 * one selected company is small: legacy edge visibility is caller-wide. Both authorized nodes
 * and structural edges must fit. The bounded probes and old reader share a read-only carrier.
 */
export async function orgChartEntry(ctx:SessionContext,companyIds:string[]|undefined){
 const actor={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))},scope=companyIds?.slice();
 const selected=await withOrgChartReadTx(actor,async tx=>{
  const [size]=await tx.execute<{large:boolean}>(sql`with ${orgGraphRelations(sql`true`)}
   select case when (select count(*) from(select id from live limit ${ORG_FULL_GRAPH_LIMIT+1})people)>${ORG_FULL_GRAPH_LIMIT} then true
    else (select count(*) from(select id from native_edges limit ${ORG_FULL_GRAPH_LIMIT+1})edges)>${ORG_FULL_GRAPH_LIMIT} end as large`);
  if(size.large)return {mode:'explorer' as const};
  const {orgChartData}=await import('./read');
  return {mode:'full' as const,...await orgChartData(actor,scope,tx)};
 });
 if(selected.mode==='full')return selected;
 return {mode:'explorer' as const,initial:await orgChartWindow(actor,scope,{view:'roots'})};
}

/** Company selection filters PEOPLE, matching the existing reader. Structural edge authorization
 * stays caller-wide: a permitted edge outside that selection is explicitly unlabelled, not removed
 * or used to grant Personnel access. Connections are paged as edges, other views as distinct people.
 * Each request proves current principal and native visibility again; nothing caches permissions.
 */
export async function orgChartWindow(ctx:SessionContext,companyIds:string[]|undefined,input:OrgWindowRequest):Promise<OrgWindow>{
 if(!input||!views.has(input.view)||input.q!==undefined&&(typeof input.q!=='string'||input.q.length>200)
  ||input.focusId!==undefined&&!UUID.test(input.focusId)||input.after!==undefined&&!UUID.test(input.after))throw new RangeError('Invalid organization window');
 const request={...input,q:input.q?.trim().toLowerCase()??''};
 const focused=['children','parents','connections'].includes(request.view);
 if(focused&&!request.focusId||!focused&&request.focusId!==undefined||request.view!=='search'&&request.q)throw new RangeError('Invalid organization window');
 const actor={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const scope=companyIds?.slice();
 const scopeWhere=scope?.length?sql`l.company_id in (${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)})`:sql`true`;
 const focus=sql`${request.focusId??null}::uuid`,after=sql`${request.after??null}::uuid`;
 let candidates:SQL;
 if(request.view==='connections')candidates=sql`
  select e.id as row_key,''::text as sort_name,
    case when e.manager_id=${focus} then e.subordinate_id else e.manager_id end as node_id,
    e.type,case when e.manager_id=${focus} then 'outgoing' else 'incoming' end::text as direction
  from native_edges e where e.manager_id=${focus} or e.subordinate_id=${focus}`;
 else{
  let predicate:SQL=sql`true`;
  if(request.view==='roots')predicate=sql`not exists(select 1 from native_edges e join eligible manager on manager.id=e.manager_id where e.subordinate_id=n.id and e.type='administrative')`;
  if(request.view==='children')predicate=sql`exists(select 1 from native_edges e where e.manager_id=${focus} and e.subordinate_id=n.id and e.type='administrative')`;
  if(request.view==='parents')predicate=sql`exists(select 1 from native_edges e where e.subordinate_id=${focus} and e.manager_id=n.id and e.type='administrative')`;
  if(request.view==='search')predicate=sql`exists(
   select 1 from (select n.id) subject
   left join public.assignment a on a.employment_id=subject.id and a.valid_to is null and a.superseded_at is null
   left join public.position p on p.id=a.position_id left join public.department d on d.id=a.department_id
   where position(${request.q} in lower(n.name||' '||coalesce(p.title,'')||' '||coalesce(d.name,'')))>0)`;
  const relation=request.view==='children'||request.view==='parents'?'administrative':null;
  const direction=request.view==='children'?'outgoing':request.view==='parents'?'incoming':null;
  candidates=sql`select n.id as row_key,n.name as sort_name,n.id as node_id,${relation}::text as type,${direction}::text as direction from eligible n where ${predicate}`;
 }
 return withOrgChartReadTx(actor,async tx=>{
  const [result]=await tx.execute<{focus:OrgWindowNode|null;items:OrgWindowItem[];total_people:number;total_items:number;focus_exists:boolean;cursor_exists:boolean}>(sql`
   with ${orgGraphRelations(scopeWhere)},candidates as materialized(${candidates}),selected as materialized(
    select c.* from candidates c where ${after} is null or (c.sort_name,c.row_key)>(select a.sort_name,a.row_key from candidates a where a.row_key=${after})
    order by c.sort_name,c.row_key limit ${ORG_WINDOW_SIZE+1}
   ),requested_nodes as materialized(select node_id as id from selected union select ${focus}),
   node_details as materialized(
    select n.id,jsonb_build_object('employmentId',n.id,'name',n.name,'employeeCode',n.employee_code,
      'role',labels.role,'department',labels.department,'assignmentCount',labels.assignments) as value
    from eligible n join requested_nodes wanted on wanted.id=n.id
    cross join lateral(
     select count(*)::int as assignments,case when count(*)=1 then max(p.title) end as role,case when count(*)=1 then max(d.name) end as department
     from public.assignment a left join public.position p on p.id=a.position_id left join public.department d on d.id=a.department_id
     where a.employment_id=n.id and a.valid_to is null and a.superseded_at is null
    ) labels
   )
   select (select value from node_details where id=${focus}) as focus,
    coalesce((select jsonb_agg(jsonb_build_object('key',s.row_key,'node',d.value,'otherEmploymentId',s.node_id,
      'type',s.type,'direction',s.direction,'inSelectedScope',d.id is not null)order by s.sort_name,s.row_key)
      from selected s left join node_details d on d.id=s.node_id),'[]'::jsonb) as items,
    (select count(*)::int from eligible) as total_people,(select count(*)::int from candidates) as total_items,
    (${focus} is null or exists(select 1 from eligible where id=${focus})) as focus_exists,
    (${after} is null or exists(select 1 from candidates where row_key=${after})) as cursor_exists
  `);
  if(result.focus_exists!==true)throw new OrgWindowUnavailableError('focus');
  if(result.cursor_exists!==true)throw new OrgWindowUnavailableError('cursor');
  const items=result.items.slice(0,ORG_WINDOW_SIZE);
  return {version:1 as const,view:request.view,focus:result.focus,items,totalPeople:Number(result.total_people),totalItems:Number(result.total_items),pageSize:ORG_WINDOW_SIZE,
   nextCursor:result.items.length>ORG_WINDOW_SIZE?items.at(-1)!.key:null};
 });
}

/** Disposable read-only comparison of the supported slice. Private search and quality filters are excluded. */
import {sql} from 'drizzle-orm';
import {employmentStatusSql} from '../../core/employment-status-sql';
import {withPersonnelRead} from '../../core/personnel-read-bounds';
import type {SessionContext} from '../../db/client';
import type {personnelDatedTagsPrototype} from './personnel-dated-tags-prototype';

type Prototype=Awaited<ReturnType<typeof personnelDatedTagsPrototype>>;
type ProbeInput={
 date:string;scope:string[];subjects:string[]|null;limit:number;offset:number;
 pageQuery?:string;facetQuery?:string;companySort?:true;
};
type Summary={pageIds:string[];total:number;byStatus:Record<string,number>;options:unknown[]};
type Detail={employmentId:string};

export function personnelNarrowOverviewProbe(
 ctx:SessionContext,prototype:Prototype,variant:'baseline'|'narrow'|'inlineNarrow',input:ProbeInput,
) {
 const {date,scope,subjects,limit,offset,pageQuery,facetQuery,companySort}=input;
 const field=(key:string)=>sql`value->>${key}`;
 const day=(key:string)=>sql`(${field(key)})::date`;
 const status=employmentStatusSql(date,{
  blacklistedAt:day('blacklistedAt'),resignationDate:day('resignationDate'),lastWorkingDate:day('lastWorkingDate'),
  terminatedOn:day('terminatedOn'),finalConfirmationDate:day('finalConfirmationDate'),confirmationDate:day('confirmationDate'),
  probationEndDate:day('probationEndDate'),provisionalEndOn:day('provisionalEndOn'),
 });
 const matches=(value:string|undefined)=>{
  const q=value?.trim();
  if(!q)return sql`true`;
  const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  return sql`(${field('name')} ilike ${term} or ${field('email')} ilike ${term} or ${field('employeeCode')} ilike ${term})`;
 };
 const ordering=companySort?sql`lower(company),lower(name),id`:sql`name,id`;
 return withPersonnelRead(ctx,async tx=>{
  const [summary]=await tx.execute<Summary>(sql`
   with facts as materialized (
    select (${field('employmentId')})::uuid as id,${field('name')} as name,${field('company')} as company,
      ${status} as status,${matches(pageQuery)} as page_matches,${matches(facetQuery)} as facet_matches,
      (${field('businessUnitId')})::uuid as "businessUnitId",${field('businessUnit')} as "businessUnit",
      (${field('positionId')})::uuid as "positionId",${field('position')} as position
    from ${prototype.source(variant,date,scope,subjects)}
    where (${field('companyId')})::uuid in (${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)})
   ),
   page as (select id,name,company from facts where page_matches order by ${ordering} limit ${limit} offset ${offset}),
   status_counts as (select status,count(distinct id)::int as count from facts where facet_matches group by status),
   options as (select distinct "businessUnitId","businessUnit","positionId",position from facts)
   select
    array(select id from page order by ${ordering}) as "pageIds",
    (select count(distinct id)::int from facts where page_matches) as total,
    (select coalesce(jsonb_object_agg(status,count),'{}'::jsonb) from status_counts) as "byStatus",
    (select coalesce(jsonb_agg(to_jsonb(o) order by to_jsonb(o)::text),'[]'::jsonb) from options o) as options
  `);
  const rows=summary.pageIds.length?await tx.execute<{value:Detail}>(sql`
   select value from ${prototype.source(variant==='baseline'?'baseline':'pageDetails',date,scope,summary.pageIds)}
  `):[];
  const details=new Map(rows.map(row=>[row.value.employmentId,row.value]));
  return {...summary,rows:summary.pageIds.map(id=>details.get(id)??null)};
 },{sharedAccessLock:true});
}

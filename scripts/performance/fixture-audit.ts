/** Read-only audit precondition for the fictional performance database. */
import assert from 'node:assert/strict';
import type {Sql} from 'postgres';
export type FixtureAuditCount={tenant_id:string;events:number;chained:number;initialization_prefix:number};
export async function fixtureAuditCounts(client:Sql,tenantIds:readonly string[]):Promise<FixtureAuditCount[]>{
 const ids=[...tenantIds];
 return [...await client<FixtureAuditCount[]>`with events as(
  select tenant_id,event_type,chain_seq,sequence,min(sequence)filter(where chain_seq is not null)over(partition by tenant_id)as first_chained
  from domain_event where tenant_id=any(${ids}::uuid[]))
  select tenant_id,count(*)::int as events,count(*)filter(where chain_seq is not null)::int as chained,
  count(*)filter(where chain_seq is null and event_type='access-configuration.initialized'and sequence<first_chained)::int as initialization_prefix
  from events group by tenant_id`];
}
export function assertFixtureAudit(rows:readonly FixtureAuditCount[],tenantIds:readonly string[]):void{
 assert.equal(rows.length,tenantIds.length,'every fixture tenant must have audit events');
 assert.equal(new Set(rows.map(row=>row.tenant_id)).size,rows.length,'duplicate fixture audit tenant');
 for(const id of tenantIds){
  const row=rows.find(value=>value.tenant_id===id);
  assert(row&&row.chained>0&&row.initialization_prefix===1&&row.events===row.chained+row.initialization_prefix,
   'all fixture events after the single canonical initialization prefix must be chained');
 }
}

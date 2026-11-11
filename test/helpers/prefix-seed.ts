/** Prefix-era seeds for populated upgrade tests. A database still at an older journal prefix lacks the columns
 * later migrations add, so a row copied through the current Drizzle schema names columns it does not have (42703).
 * This copies one tenant's rows of a schema table naming only the schema columns that exist at the target's
 * prefix, read from the target's own catalogue. A schema column the prefix lacks must be null on every copied row,
 * so the seed never silently drops a value. Values travel as PostgreSQL JSON text (no JavaScript number or date
 * conversion) and destination triggers stay enabled. */
import {expect} from 'vitest';
import {getTableColumns,getTableName} from 'drizzle-orm';
import type {PgTable} from 'drizzle-orm/pg-core';
import type {createDb} from '../../db/client';
type Database=ReturnType<typeof createDb>;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

export async function copyTenantRowsAtPrefix(source:Database,target:Database,table:PgTable,tenantId:string):Promise<number>{
 const name=getTableName(table);
 const atPrefix=new Set((await target.client`select column_name from information_schema.columns
  where table_schema='public' and table_name=${name} and is_generated='NEVER'`).map(row=>String(row.column_name)));
 expect(atPrefix.size,name+' exists at the prefix').toBeGreaterThan(0);
 const columns=Object.values(getTableColumns(table)).map(column=>column.name);
 const kept=columns.filter(column=>atPrefix.has(column)),later=columns.filter(column=>!atPrefix.has(column));
 expect(kept.length,name+' columns at the prefix').toBeGreaterThan(0);
 // Only the named keys leave the source: the prefix-era columns to copy, and the later columns to prove null.
 const pick=(parameter:string)=>'(select coalesce(jsonb_object_agg(e.key,e.value),\'{}\'::jsonb) from jsonb_each(to_jsonb(t)) e where e.key in (select jsonb_array_elements_text('+parameter+'::jsonb)))::text';
 const rows=(await source.client.unsafe('select '+pick('$2')+' as kept,'+pick('$3')+' as later from public.'+quote(name)+' t where t.'+(name==='tenant'?'id':'tenant_id')+'=$1::uuid',[tenantId,JSON.stringify(kept),JSON.stringify(later)]))
  .map(row=>({kept:String(row.kept),later:JSON.parse(String(row.later)) as Record<string,unknown>}));
 for(const row of rows)for(const column of later){
  expect(Object.hasOwn(row.later,column),name+'.'+column+' exists in the source').toBe(true);
  expect(row.later[column],name+'.'+column+' postdates the prefix, so a prefix-era row holds null').toBeNull();
 }
 if(!rows.length)return 0;
 const list=kept.map(quote).join(',');
 await target.client.unsafe('insert into public.'+quote(name)+'('+list+') select '+list+' from jsonb_populate_recordset(null::public.'+quote(name)+',$1::jsonb)',
  ['['+rows.map(row=>row.kept).join(',')+']']);
 return rows.length;
}

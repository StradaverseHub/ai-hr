import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {refusedLabelCollisionProposalsTx,LABEL_COLLISION_PREVIEW_PAIR_LIMIT,type LabelCollisionProposal} from '../core/system-labels';
const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
const migration=read('../db/migrations/0550_system_label_company_criteria.sql');
const uuid='00000000-0000-0000-0000-000000000001';
const pair:LabelCollisionProposal={key:'row1:row2',kind:'cost_center',code:'hq',first:{id:uuid,global:true,companyIds:[]},second:{id:null,global:false,companyIds:[uuid]}};
describe('inherited label collision single-owner contracts',()=>{
 it('batches projected pairs through the DB read predicate with NULL for a new row, returning explicit refused keys',async()=>{
  const queries:{sql:string;params:unknown[]}[]=[],dialect=new PgDialect();
  const tx={execute:vi.fn(async(query:SQL)=>{queries.push(dialect.sqlToQuery(query));return [{key:pair.key}];})} as unknown as Tx;
  expect(await refusedLabelCollisionProposalsTx(tx,uuid,[pair])).toEqual([pair.key]);
  expect(queries).toHaveLength(1);expect(queries[0].sql).toContain('app.system_label_collision_allowed');
  expect(queries[0].params).toEqual([JSON.stringify([pair]),uuid]);
  expect(queries[0].sql).not.toMatch(/insert|update|delete/i);
 });
 it('bounds malformed or oversized preview proposals before any query and accepts an empty set without IO',async()=>{
  const execute=vi.fn(),tx={execute} as unknown as Tx;
  expect(await refusedLabelCollisionProposalsTx(tx,uuid,[])).toEqual([]);
  await expect(refusedLabelCollisionProposalsTx(tx,uuid,Array.from({length:LABEL_COLLISION_PREVIEW_PAIR_LIMIT+1},()=>pair))).rejects.toThrow(/smaller workbook/);
  await expect(refusedLabelCollisionProposalsTx(tx,uuid,[pair,pair])).rejects.toThrow(/identity/);
  await expect(refusedLabelCollisionProposalsTx(tx,uuid,[{...pair,first:{...pair.first,id:'new:worksheet:2'}}])).rejects.toThrow(/Criteria/);
  expect(execute).not.toHaveBeenCalled();
 });
 it('keeps baseline writes private, migration-only capture generic, and the reducer monotone',()=>{
  expect(migration).toContain('GRANT SELECT ON system_label_collision_baseline TO ai_hr_app');
  expect(migration).not.toMatch(/GRANT[^;]*(?:INSERT|UPDATE|DELETE|ALL)[^;]*ON system_label_collision_baseline TO ai_hr_app/i);
  expect(migration).toContain('REVOKE ALL ON FUNCTION app.reduce_system_label_collision_baseline() FROM PUBLIC,ai_hr_app');
  const reducer=migration.slice(migration.indexOf('CREATE FUNCTION app.reduce_system_label_collision_baseline()'),migration.indexOf('REVOKE ALL ON FUNCTION app.reduce_system_label_collision_baseline()'));
  expect(reducer).toContain('SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp');
  expect(reducer).toContain('TG_RELID NOT IN');expect(reducer).toContain('AND retired_at IS NULL');
  expect(reducer).toContain('x.company_id=ANY(v_row.company_ids)');
  expect(reducer).not.toMatch(/INSERT INTO public.system_label_collision_baseline|DELETE FROM public.system_label_collision_baseline/);
  expect(migration).not.toContain('054f6924-75f9-46f9-8e97-444e8e6eb3a1');
  expect(migration).toContain('a.id<b.id');expect(migration).toContain('a.is_global AND b.is_global');
  expect(migration).toContain('LOCK TABLE department,position,cost_center,business_unit,label_company_assignment');
 });
 it('keeps manual Criteria collision ownership and gives import a stricter tenant-wide existence check',()=>{
  const service=read('../core/system-labels.ts'),workbook=read('../core/system-label-import.ts');
  expect(migration).toContain('AND NOT app.system_label_collision_allowed');
  expect(service).toContain('not app.system_label_collision_allowed');
  expect(workbook).toContain('await existingSystemLabelImportKeysTx(tx,ctx.tenantId,proposals)');
  expect(workbook).not.toContain('refusedLabelCollisionProposalsTx');
  expect(workbook).toContain('if(incumbentKeys.has(key))throw new Error(existingCodeMessage)');
  expect(workbook).toContain('{creates,updates:[]}');
 });
});

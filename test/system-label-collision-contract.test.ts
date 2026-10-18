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
  const analyseStart=workbook.indexOf('async function analyse('),analyseEnd=workbook.indexOf('export function previewSystemLabelImport(',analyseStart);
  expect(analyseStart).toBeGreaterThan(-1);expect(analyseEnd).toBeGreaterThan(analyseStart);
  const analyse=workbook.slice(analyseStart,analyseEnd);
  expect(analyse.length).toBeGreaterThan(100);
  const orgStart=analyse.indexOf('if((ORGANISATION_LABEL_KINDS as readonly string[]).includes(row.sheet)){'),orgEnd=analyse.indexOf('}else if((EMPLOYMENT_LABEL_CATEGORIES',orgStart);
  expect(orgStart).toBeGreaterThan(-1);expect(orgEnd).toBeGreaterThan(orgStart);
  expect(analyse.slice(orgStart,orgEnd)).toContain("if(incumbentKeys.has(key))throw new LabelImportRowError('existing',existingCodeMessage)");
  // Incumbents remain visible refusals with no before image; only selected new rows reach creates.
  expect(analyse).toContain("outcome:'error',message:'',before:null");
  expect(analyse).toContain("result.reason=error instanceof LabelImportRowError?error.reason:'invalidRow'");
  expect(analyse).toContain("result.outcome='error';result.selected=false");
  expect(analyse).toContain("writes.filter(write=>output.some(row=>row.selected&&row.outcome==='add'&&row.sheet+':'+row.row===write.key))");
  expect(analyse).toContain('bulkSaveLabels(ctx,kind,{creates,updates:[]},tx)');

  // Confirmation independently repeats the existence analysis under the canonical writers' lock;
  // a preview is neither an update right nor a reservation against a concurrent creator.
  const applyStart=workbook.indexOf('export function applySystemLabelImport(');
  expect(applyStart).toBeGreaterThan(analyseEnd);
  const apply=workbook.slice(applyStart);
  expect(apply.length).toBeGreaterThan(100);
  expect(apply).toMatch(/await lockLabelCriteriaTx\(tx,ctx.tenantId\);[\s\S]*await analyse\(tx,ctx,rows,audit,p.selectedKeys\);[\s\S]*if\(preview.token!==p.token\)throw new Error[\s\S]*if\(!preview.valid\)throw new Error[\s\S]*for\(const write of writes\)await write\(\);/);
  const admin=read('../core/admin.ts'),ownerStart=admin.indexOf('export async function bulkSaveLabels('),ownerEnd=admin.indexOf('const errors: LabelRowError[]',ownerStart);
  expect(ownerStart).toBeGreaterThan(-1);expect(ownerEnd).toBeGreaterThan(ownerStart);
  expect(admin.slice(ownerStart,ownerEnd)).toContain('await lockLabelCriteriaTx(tx, ctx.tenantId);');
 });
});

import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import {type SQL} from 'drizzle-orm';
import {type Tx} from '../db/client';
import {lockLabelCriteriaTx} from '../core/system-labels';

describe('System Labels persistent epoch lock order',()=>{
 it('awaits all four canonical epochs before the caller may take reference row locks',async()=>{
  const calls:unknown[][]=[],dialect=new PgDialect();let inFlight=0;
  const tx={execute:vi.fn(async(query:SQL)=>{expect(inFlight).toBe(0);inFlight++;await Promise.resolve();calls.push(dialect.sqlToQuery(query).params);inFlight--;})} as unknown as Tx;
  await lockLabelCriteriaTx(tx,'00000000-0000-0000-0000-000000000001');
  expect(calls).toEqual(['department','position','cost_center','business_unit'].map(kind=>['00000000-0000-0000-0000-000000000001',kind]));
  expect(inFlight).toBe(0);
 });
 it('keeps workbook table locks off Criteria and reference tables after epoch acquisition',()=>{
  const source=readFileSync(new URL('../core/system-label-import.ts',import.meta.url),'utf8');
  const locks=[...source.matchAll(/LOCK TABLE ([^`]+) IN SHARE ROW EXCLUSIVE MODE/g)].map(match=>match[1].split(',').map(value=>value.trim().replaceAll('"','')));
  expect(locks.length).toBeGreaterThan(0);
  for(const tables of locks){expect(tables).toEqual(['profile_option','job_grade','grade_group','grade_group_member']);}
  expect(source).toContain('await lockLabelCriteriaTx(tx,ctx.tenantId)');
 });
});

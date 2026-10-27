/** Frozen external allocation witness. Do not regenerate from the candidate to mask a mismatch. */
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import allocation from './fixtures/mobile-integrity/coordinated-migrations.json';
const root=new URL('../db/migrations/',import.meta.url);
const journal=JSON.parse(readFileSync(new URL('meta/_journal.json',root),'utf8')).entries;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
describe('coordinated unapplied Mobile migration integration',()=>{
 it('preserves the complete canonical prefix at the allocated source freeze',()=>{
  expect(allocation.canonicalPrefixCommit).toBe('9541b1686d7941f89e564723271e48bf85a21a89');
  expect(hash(JSON.stringify(journal.slice(0,allocation.prefixEntries)))).toBe(allocation.prefixEntriesSHA256);
 });
 it('includes every earlier Board/AI prerequisite before the four Mobile entries',()=>{
  const actual=journal.slice(allocation.prefixEntries,allocation.prefixEntries+allocation.rows.length);
  expect(actual).toEqual(allocation.rows.map(({idx,version,when,tag,breakpoints})=>({idx,version,when,tag,breakpoints})));
  expect(allocation.rows.filter(row=>row.owner==='Mobile').map(row=>row.idx)).toEqual([630,631,632,633]);
 });
 it('preserves the exact SQL body bytes bound by all eighteen allocations',()=>{
  for(const row of allocation.rows)expect(hash(readFileSync(new URL(row.tag+'.sql',root))),row.tag).toBe(row.sourceSHA256);
 });
 it('retires only the superseded unapplied filenames while retaining the budget tag',()=>{
  for(const row of allocation.rows){
   if('originalTag' in row&&row.originalTag!==row.tag)expect(existsSync(new URL(row.originalTag+'.sql',root))).toBe(false);
  }
  expect(existsSync(new URL('0613_request_abuse_budgets.sql',root))).toBe(true);
 });
});

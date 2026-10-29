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
 // Re-pinned 29 October 2026 (staging release of the Mobile work): the 27 October allocation put the four Mobile entries at
 // idx 630-633 with when values that alpha's applied ledger later passed (the AI/Board prerequisites were re-journaled
 // there at their own idx/when). A Mobile entry journaled below an applied `when` is silently skipped by drizzle, so the
 // invariant that still matters is ORDER: every prerequisite is journaled, and every Mobile entry comes after all of them,
 // in the allocated relative order, each with a `when` above every entry journaled before it. The positional pin is retired, not deleted.
 it('journals every Board/AI prerequisite, then the Mobile entries after them, each with a when above everything journaled before it',()=>{
  const at=(tag:string)=>journal.findIndex((row:{tag:string})=>row.tag===tag);
  const prerequisites=allocation.rows.filter(row=>row.owner!=='Mobile'),mobile=allocation.rows.filter(row=>row.owner==='Mobile');
  expect(prerequisites.length).toBe(14);expect(mobile.map(row=>row.tag)).toEqual(['0613_request_abuse_budgets','0633_geofence_reported_uncertainty','0634_mobile_integrity_challenges','0635_mobile_integrity_keys']);
  for(const row of prerequisites)expect(at(row.tag),row.tag).toBeGreaterThanOrEqual(0);
  const later=['0636_mobile_android_key_custody','0647_mobile_offline_attendance','0673_mobile_push_tokens'];
  const mobileTags=[...mobile.map(row=>row.tag),...later],positions=mobileTags.map(at);
  for(const [i,tag] of mobileTags.entries())expect(positions[i],tag).toBeGreaterThanOrEqual(0);
  expect([...positions].sort((a,b)=>a-b)).toEqual(positions);
  // Above every entry journaled BEFORE it (later releases may land above Mobile; that is their re-allocation).
  for(const tag of mobileTags){const i=at(tag);expect(journal[i].when,tag).toBeGreaterThan(Math.max(...journal.slice(0,i).map((row:{when:number})=>row.when)));}
  expect(Math.min(...positions)).toBeGreaterThan(Math.max(...prerequisites.map(row=>at(row.tag))));
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

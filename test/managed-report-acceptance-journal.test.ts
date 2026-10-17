import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import {describe,it,expect} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const source=readFileSync(new URL('../scripts/dev-managed-report-acceptance.ts',import.meta.url),'utf8');
const journal=JSON.parse(readFileSync(new URL('../db/migrations/meta/_journal.json',import.meta.url),'utf8')) as {entries:{tag:string;when:number}[]};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const applied=journal.entries.map((entry,index)=>({id:index+1,created_at:entry.when,hash:hash(readFileSync(new URL('../db/migrations/'+entry.tag+'.sql',import.meta.url)))}));
// Exercise the actual acceptance query + complete count/hash/when comparison without starting its CLI.
// The tiny SQL adapter models only the two possible ORDER BY clauses on these real journal rows;
// no DB endpoint, role, identity, fixture writer or acceptance outcome is mocked as authorised.
async function compare(rows:typeof applied){
 const start=source.indexOf(' const applied=await owner.client`'),end=source.indexOf(" for(const name of ['app.employee_master_internal_render_context",start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);expect(end-start).toBeGreaterThan(300);
 const owner={client:async(parts:TemplateStringsArray)=>{const sql=parts.join('?');
  if(sql==='select hash,created_at from drizzle.__drizzle_migrations order by id')return [...rows].sort((a,b)=>a.id-b.id);
  if(sql==='select hash,created_at from drizzle.__drizzle_migrations order by created_at')return [...rows].sort((a,b)=>a.created_at-b.created_at);
  throw new Error('Unexpected migration reader SQL.');
 }};
 const block=new Script('(async()=>{'+source.slice(start,end)+'})()');
 await block.runInNewContext({owner,journal,check:(allowed:boolean,message:string)=>{if(!allowed)throw new Error(message);},hash,fs:{readFile:async(file:string)=>readFileSync(file)},ROOT:root},{timeout:1000});
}
describe('canonical managed Report acceptance journal readback',()=>{
 it('accepts all460 authentic applied rows in insertion order despite the legacy0230→0240 timestamp descent',async()=>{
  const at=journal.entries.findIndex(row=>row.tag==='0230_delegation_scope_reason');expect(at).toBeGreaterThanOrEqual(0);
  expect(journal.entries[at+1].tag).toBe('0240_employment_blacklist');expect(journal.entries[at].when).toBe(1781862229000);expect(journal.entries[at+1].when).toBe(1781862219000);
  expect(applied).toHaveLength(460);await expect(compare(applied)).resolves.toBeUndefined();
 });
 it('still refuses count, SQL hash, when and applied insertion-order drift',async()=>{
  const at=journal.entries.findIndex(row=>row.tag==='0230_delegation_scope_reason');expect(at).toBeGreaterThanOrEqual(0);
  for(const mode of ['count','hash','when','order']){const rows=applied.map(row=>({...row}));
   if(mode==='count')rows.pop();if(mode==='hash')rows[at].hash='f'.repeat(64);if(mode==='when')rows[at].created_at++;
   if(mode==='order')[rows[at].id,rows[at+1].id]=[rows[at+1].id,rows[at].id];
   await expect(compare(rows),mode).rejects.toThrow();
  }
 });
});

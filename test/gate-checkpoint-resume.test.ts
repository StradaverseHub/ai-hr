/** ADR-0133: a resumed impact gate proves exactly what one uninterrupted attempt proves, or refuses. */
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coverageBody,coverageId,existingCheckpoints,runAttempt,saveCheckpoint,summarize,unitsFor,verifyReceiptCheckpoints,
 type CoverageBody,type Execution,type Unit } from '../scripts/gate-checkpoint';

const SHA='a'.repeat(40),OTHER='b'.repeat(40),BASE='c'.repeat(40);
// Assembled so this file is not itself classified as a database test.
const dbImport="import sql from '"+'post'+"gres';";
const nodb=['test/n1.test.ts','test/n2.test.ts','test/n3.test.ts'];
const db=Array.from({length:130},(_,i)=>`test/d${String(i).padStart(3,'0')}.test.ts`);
const run=[...nodb,...db].sort();
const read=(p:string)=>p.startsWith('test/d')?dbImport:p.startsWith('test/n')?"export {};":null;
const browserFiles=['test/b.browser.test.tsx'];
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'gate-checkpoint-'));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));

const body=(over:Partial<CoverageBody>={})=>coverageBody({sha:SHA,base:BASE,deployed:BASE,environmentHash:'e'.repeat(64),policyVersion:2,tier:'impact',run,browser:true,
 units:unitsFor({run,browser:true},read,browserFiles),...over});
const green=(u:Unit):Execution=>({exitCode:0,logBytes:Buffer.from(` ✓ ok\n Test Files  ${u.files.length} passed (${u.files.length})\n`),startedAt:new Date().toISOString(),endedAt:new Date().toISOString()});
const red=(u:Unit):Execution=>({exitCode:1,logBytes:Buffer.from(` FAIL ${u.files[0]}\n Test Files  1 failed | ${u.files.length-1} passed (${u.files.length})\n`),startedAt:new Date().toISOString(),endedAt:new Date().toISOString()});
function attempt(b:CoverageBody,resume:boolean,redUnits:string[]=[],name='a'+Math.random().toString(16).slice(2,10)){
 const ran:string[]=[];
 const r=runAttempt({body:b,resume,attempt:name,planFingerprint:'f'.repeat(64),planHash:'h'.repeat(64),execute:u=>{ran.push(u.id);return redUnits.includes(u.id)?red(u):green(u);}},dir);
 return {...r,ran};
}

describe('unit partition',()=>{
 it('covers every selected file exactly once, in the runner order: no-DB, 64-file DB batches, browser',()=>{
  const units=body().units;
  expect(units.map(u=>u.id)).toEqual(['nodb','db-001','db-002','db-003','browser']);
  expect(units.map(u=>u.files.length)).toEqual([3,64,64,2,1]);
  expect(units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort()).toEqual(run);
  expect(units.map(u=>u.index)).toEqual([0,1,2,3,4]);
 });
 it('the full tier has no resumable units',()=>{expect(()=>coverageBody({...body(),tier:'full'})).toThrow('full tier');});
});

describe('resume',()=>{
 it('a resumed PASS lists the same coverage, units and file lists as a clean PASS',()=>{
  const clean=attempt(body(),false);
  expect(clean.passed).toBe(true);expect(clean.checkpoints.assembled).toBe(false);
  rmSync(join(dir,'checkpoints'),{recursive:true});
  const first=attempt(body(),false,['db-002']);
  expect(first.passed).toBe(false);
  const resumed=attempt(body(),true);
  expect(resumed.passed).toBe(true);
  expect(resumed.ran).toEqual(['db-002']);
  expect(resumed.checkpoints.assembled).toBe(true);
  expect(resumed.checkpoints.coverageId).toBe(clean.checkpoints.coverageId);
  expect(resumed.checkpoints.units.map(r=>r.unit)).toEqual(clean.checkpoints.units.map(r=>r.unit));
  expect(verifyReceiptCheckpoints(resumed.checkpoints,body(),dir)).toBeNull();
  // The red attempt stays on record and in the receipt.
  expect(resumed.checkpoints.attempts.filter(a=>!a.passed).map(a=>a.unit)).toEqual(['db-002']);
  const stored=existingCheckpoints(body(),dir).map(c=>c.checkpoint);
  expect(stored.filter(c=>c.unit==='db-002').map(c=>c.passed).sort()).toEqual([false,true]);
  for(const unit of body().units)expect(stored.find(c=>c.unit===unit.id&&c.passed)!.files).toEqual(unit.files);
 });
 it('a red batch is never skipped: resume reruns it, and a second red keeps the gate red',()=>{
  attempt(body(),false,['db-002']);
  const again=attempt(body(),true,['db-002']);
  expect(again.ran).toEqual(['db-002']);expect(again.passed).toBe(false);
  expect(again.checkpoints.units.map(r=>r.unit)).not.toContain('db-002');
  expect(verifyReceiptCheckpoints(again.checkpoints,body(),dir)).toMatch(/exactly one checkpoint per unit/);
 });
 it('a unit that never ran (aborted attempt) is run on resume',()=>{
  const b=body();
  saveCheckpoint({body:b,unit:b.units[0],attempt:'aborted',planFingerprint:'f'.repeat(64),planHash:'h'.repeat(64),...green(b.units[0])},dir);
  const resumed=attempt(b,true);
  expect(resumed.ran).toEqual(['db-001','db-002','db-003','browser']);expect(resumed.passed).toBe(true);
 });
 it('refuses to resume a changed commit, selection, partition, environment or policy',()=>{
  attempt(body(),false,['db-002']);
  const changes:Partial<CoverageBody>[]=[{sha:OTHER},{base:OTHER},{deployed:OTHER},{environmentHash:'0'.repeat(64)},{policyVersion:3},
   {run:run.slice(1),units:unitsFor({run:run.slice(1),browser:true},read,browserFiles)},
   {units:body().units.map(u=>u.id==='db-001'?{...u,files:[...u.files].reverse()}:u)}];
  for(const change of changes){
   expect(coverageId(body(change))).not.toBe(coverageId(body()));
   expect(()=>attempt(body(change),true)).toThrow('no checkpoints exist for this exact coverage');
  }
 });
 it('a green checkpoint for another commit cannot be planted into this coverage',()=>{
  attempt(body({sha:OTHER}),false);attempt(body(),false,body().units.map(u=>u.id));
  const from=join(dir,'checkpoints',OTHER,coverageId(body({sha:OTHER}))),to=join(dir,'checkpoints',SHA,coverageId(body()));
  for(const p of readdirSync(from).filter(p=>p!=='coverage.json'))cpSync(join(from,p),join(to,p));
  const resumed=attempt(body(),true);
  expect(resumed.ran).toEqual(body().units.map(u=>u.id));
  expect(resumed.passed).toBe(true);
 });
});

describe('forgery and tampering',()=>{
 const only=(suffix:string)=>{const d=join(dir,'checkpoints',SHA,coverageId(body()));return readdirSync(d).filter(p=>p.startsWith('db-002.')&&p.endsWith(suffix)).map(p=>join(d,p));};
 it('turning a red checkpoint green by editing its record does not make it evidence',()=>{
  attempt(body(),false,['db-002']);
  const [record]=only('.json'),c=JSON.parse(readFileSync(record,'utf8'));
  writeFileSync(record,JSON.stringify({...c,passed:true,exitCode:0,counted:c.asked,summaryFailed:false},null,2)+'\n');
  const resumed=attempt(body(),true);
  expect(resumed.ran).toEqual(['db-002']);
 });
 it('release refuses a receipt whose listed checkpoint record or log changed afterwards',()=>{
  const r=attempt(body(),false);expect(verifyReceiptCheckpoints(r.checkpoints,body(),dir)).toBeNull();
  const [log]=only('.log');const original=readFileSync(log);
  writeFileSync(log,original.toString()+'\n');expect(verifyReceiptCheckpoints(r.checkpoints,body(),dir)).toMatch(/log was altered/);
  writeFileSync(log,original);
  const [record]=only('.json');const bytes=readFileSync(record);
  writeFileSync(record,bytes.toString().replace('"exitCode": 0','"exitCode": 0 '));expect(verifyReceiptCheckpoints(r.checkpoints,body(),dir)).toMatch(/was altered/);
  writeFileSync(record,bytes);rmSync(record);expect(verifyReceiptCheckpoints(r.checkpoints,body(),dir)).toMatch(/missing/);
 });
 it('release refuses checkpoints that describe a different coverage or omit a unit',()=>{
  const r=attempt(body(),false);
  expect(verifyReceiptCheckpoints(r.checkpoints,body({sha:OTHER}),dir)).toMatch(/different commit/);
  expect(verifyReceiptCheckpoints({...r.checkpoints,units:r.checkpoints.units.slice(1)},body(),dir)).toMatch(/exactly one/);
  expect(verifyReceiptCheckpoints({...r.checkpoints,units:[...r.checkpoints.units.slice(1),r.checkpoints.units[1]]},body(),dir)).toMatch(/exactly one/);
  expect(verifyReceiptCheckpoints(undefined,body(),dir)).toMatch(/no unit checkpoints/);
 });
 it('a log whose count does not match its file list is red, whatever the exit code says',()=>{
  const b=body(),u=b.units[1];
  const {checkpoint}=saveCheckpoint({body:b,unit:u,attempt:'short',planFingerprint:'f'.repeat(64),planHash:'h'.repeat(64),exitCode:0,
   logBytes:Buffer.from(` Test Files  ${u.files.length-1} passed (${u.files.length-1})\n`),startedAt:'x',endedAt:'y'},dir);
  expect(checkpoint.passed).toBe(false);
 });
 it('evidence is write-once',()=>{
  const b=body(),save=()=>saveCheckpoint({body:b,unit:b.units[0],attempt:'same',planFingerprint:'f'.repeat(64),planHash:'h'.repeat(64),...green(b.units[0])},dir);
  save();expect(save).toThrow('cannot be overwritten');
 });
});

describe('vitest summary',()=>{
 it('reads the final Test Files line and its failures',()=>{
  expect(summarize(' Test Files  64 passed (64)\n')).toEqual({counted:64,failed:false});
  expect(summarize(' Test Files  1 failed | 63 passed (64)\n')).toEqual({counted:64,failed:true});
  expect(summarize('no summary')).toEqual({counted:null,failed:true});
 });
});

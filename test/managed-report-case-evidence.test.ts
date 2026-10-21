import {mkdtempSync,readFileSync,readdirSync,rmSync,chmodSync,mkdirSync,symlinkSync,lstatSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createManagedReportCaseRecorder} from '../scripts/managed-report-case-evidence';
const storage=vi.hoisted(()=>({syncs:[] as boolean[],failAt:0}));
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>();
 return {...actual,fsyncSync:(fd:number)=>{
  storage.syncs.push(actual.fstatSync(fd).isDirectory());
  if(storage.failAt===storage.syncs.length)throw new Error('Injected evidence sync failure.');
  actual.fsyncSync(fd);
 }};
});
const temporary:string[]=[];
function privateParent(){const root=mkdtempSync(join(tmpdir(),'aihr-report-case-'));chmodSync(root,0o700);temporary.push(root);return realpathSync(root);}
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});storage.syncs=[];storage.failAt=0;});
const binding={candidate:'a'.repeat(40),runId:'11111111-1111-4111-8111-111111111111'};
describe('durable owned Reports case attribution',()=>{
 it('pins the source binding and syncs parent entry before case bytes and its directory entry',()=>{
  const directory=join(privateParent(),'cases'),mutable={...binding},record=createManagedReportCaseRecorder(directory,mutable);
  expect(storage.syncs).toEqual([true]);
  mutable.candidate='b'.repeat(40);mutable.runId='22222222-2222-4222-8222-222222222222';record('caseOne');
  expect(storage.syncs).toEqual([true,false,true]);
  expect(JSON.parse(readFileSync(join(directory,'001-caseOne.json'),'utf8'))).toMatchObject(binding);
 });
 it.each([2,3])('refuses further writes after a case durability failure at sync %s, preserving partial evidence',failAt=>{
  const directory=join(privateParent(),'cases'),record=createManagedReportCaseRecorder(directory,binding);
  storage.failAt=failAt;expect(()=>record('caseOne')).toThrow('Injected evidence sync failure.');
  const names=readdirSync(directory),bytes=readFileSync(join(directory,'001-caseOne.json')),syncCount=storage.syncs.length;
  expect(()=>record('caseTwo')).toThrow('Case evidence storage failed');
  expect(readdirSync(directory)).toEqual(names);expect(readFileSync(join(directory,'001-caseOne.json'))).toEqual(bytes);
  expect(storage.syncs).toHaveLength(syncCount);
 });
 it('refuses construction when the new directory entry cannot be synced and cannot reuse that path',()=>{
  const directory=join(privateParent(),'cases');storage.failAt=1;
  expect(()=>createManagedReportCaseRecorder(directory,binding)).toThrow('Injected evidence sync failure.');
  expect(readdirSync(directory)).toEqual([]);
  expect(()=>createManagedReportCaseRecorder(directory,binding)).toThrow();
 });
 it('retains independently readable case evidence after a later case fails, without claiming a complete journey',()=>{
  const directory=join(privateParent(),'cases'),record=createManagedReportCaseRecorder(directory,binding);
  const details={rows:2,sha256:'b'.repeat(64)},first=record('actualWeekly',details);details.rows=999;expect(first.details.rows).toBe(2);record('actualMonthly',{rows:2});
  expect(()=>{throw new Error('A later case failed');}).toThrow();
  const names=readdirSync(directory).sort();expect(names).toHaveLength(2);
  const bytes=names.map(name=>readFileSync(join(directory,name))),rows=bytes.map(raw=>JSON.parse(raw.toString()));
  expect(rows[0]).toMatchObject({...binding,sequence:1,previousSha256:null,status:'VERIFIED',completeJourney:false,name:'actualWeekly'});
  expect(rows[1]).toMatchObject({sequence:2,previousSha256:createHash('sha256').update(bytes[0]).digest('hex'),completeJourney:false,name:'actualMonthly'});
  for(const name of names)expect(lstatSync(join(directory,name)).mode&0o777).toBe(0o600);
 });
 it('refuses replay, duplicate identities, an unbounded outcome and existing paths without overwriting earlier bytes',()=>{
  const directory=join(privateParent(),'cases'),record=createManagedReportCaseRecorder(directory,binding);record('caseOne');
  const file=join(directory,'001-caseOne.json'),before=readFileSync(file);
  expect(()=>record('caseOne')).toThrow();expect(()=>createManagedReportCaseRecorder(directory,binding)).toThrow();
  expect(()=>record('../escape')).toThrow();expect(()=>record('caseLarge',{text:'x'.repeat(65536)})).toThrow();
  expect(readFileSync(file)).toEqual(before);expect(readdirSync(directory)).toEqual(['001-caseOne.json']);
  record('caseTwo');expect(JSON.parse(readFileSync(join(directory,'002-caseTwo.json'),'utf8')).sequence).toBe(2);
 });
 it('refuses symlinked or public parents and malformed source bindings',()=>{
  const parent=privateParent(),linked=join(parent,'link');symlinkSync(parent,linked);
  expect(()=>createManagedReportCaseRecorder(join(linked,'cases'),binding)).toThrow();
  const publicParent=join(parent,'public');mkdirSync(publicParent,{mode:0o755});chmodSync(publicParent,0o755);
  expect(()=>createManagedReportCaseRecorder(join(publicParent,'cases'),binding)).toThrow();
  expect(()=>createManagedReportCaseRecorder(join(parent,'bad-source'),{...binding,candidate:'unknown'})).toThrow();
 });
});

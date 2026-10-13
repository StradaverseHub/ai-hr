import { describe,expect,it } from 'vitest';
import { planImpact,riskFor } from '../scripts/gate-impact';
import type { ChangedFile } from '../scripts/gate-tier';
const change=(path:string,baseText='export const value=1;',headText='export const value=2;'):ChangedFile=>({path,status:'M',baseText,headText,diffLines:[baseText,headText]});
const fixture=()=>new Map([
 ['lib/value.ts','export const value=2;'],['app/consumer.ts',"export {value} from '../lib/value';"],
 ['test/value.test.ts',"import {value} from '../app/consumer';"],['test/unrelated.test.ts','export {};'],
 ['test/function-access.test.ts','export {};'],['test/tenant-isolation.test.ts','export {};'],
]);
describe('deterministic risk and transitive test selection',()=>{
 it('selects executable consumers across a re-export, plus mandatory invariants, and explains every selection',()=>{
  const p=planImpact([change('lib/value.ts')],fixture());expect(p.tier).toBe('impact');expect(p.risk).toBe('moderate');
  expect(p.run).toEqual(['test/function-access.test.ts','test/tenant-isolation.test.ts','test/value.test.ts']);
  expect(p.selection['test/value.test.ts']).toEqual(['transitive import consumer of lib/value.ts']);
 });
 it('reuses a diagnostic-only classification while a control-flow change remains a logic change',()=>{
  const c=change('core/attendance-clock.ts',"export function x(){throw new ClockLocationError('location');}","export function x(){throw new ClockLocationError('location and accuracy');}");
  expect(riskFor(c).risk).toBe('low');expect(riskFor({...c,headText:"export function x(){if(false)throw new ClockLocationError('location');}"}).risk).toBe('high');
 });
 it.each(['db/migrations/0600.sql','db/schema.ts','lib/permissions.ts','core/auth.ts','core/attendance-rule.ts','packs/payroll/service.ts','localization/my/pcb.ts','scripts/gate.sh','deploy/deploy.sh','pnpm-lock.yaml','test/global-setup.ts'])('%s retains full verification',path=>{
  expect(riskFor(change(path)).risk).toBe('high');expect(planImpact([change(path)],fixture()).tier).toBe('full');
 });
 it('requires evidence for unknown ownership and uncovered new product modules',()=>{
  expect(planImpact([change('new-owner/code.ts')],fixture()).risk).toBe('unknown');
  expect(planImpact([change('lib/uncovered.ts')],fixture()).classifications[0].uncertainties).toContain('no behavioral consumer');
 });
 it('includes source-reading tests without requiring a guard filename or a textual mention of the changed file',()=>{
  const files=fixture();files.set('test/helpers/read-source.ts',"import {readFileSync} from 'node:fs'; export const read=(p:string)=>readFileSync(p,'utf8');");
  files.set('test/plain.test.ts',"import {read} from './helpers/read-source';");
  const p=planImpact([change('lib/value.ts')],files);expect(p.run).toContain('test/plain.test.ts');
 });
 it('includes consumers of an unchanged computed loader, but an edited computed loader itself stays unknown',()=>{
  const files=fixture();files.set('app/loader.ts','export const load=(name:string)=>import(name);');files.set('test/loader.test.ts',"import {load} from '../app/loader';");
  expect(planImpact([change('lib/value.ts')],files).run).toContain('test/loader.test.ts');
  expect(planImpact([change('app/loader.ts','export {};',files.get('app/loader.ts')!)],files).tier).toBe('full');
 });
 it('retains removed import edges and deleted-module consumers',()=>{
  const files=fixture();files.set('app/consumer.ts','export const value=2;');files.delete('lib/value.ts');
  const deleted={...change('lib/value.ts'),status:'D',headText:null};
  const changed=change('app/consumer.ts',"export {value} from '../lib/value';",files.get('app/consumer.ts')!);
  expect(planImpact([deleted,changed],files).run).toContain('test/value.test.ts');
 });
 it('learned failures broaden future selection even when there is no static dependency',()=>{
  const p=planImpact([change('lib/value.ts')],fixture(),[{changed:['lib/value.ts'],failed:['test/unrelated.test.ts']}]);
  expect(p.run).toContain('test/unrelated.test.ts');expect(p.selection['test/unrelated.test.ts'][0]).toContain('failure observed');
 });
 it('new executable coverage can move an unknown module into a known category; green history alone cannot',()=>{
  const files=fixture(),c=change('lib/new.ts');files.set(c.path,c.headText!);
  expect(planImpact([c],files).risk).toBe('unknown');files.set('test/new.test.ts',"import '../lib/new';");
  expect(planImpact([c],files).risk).toBe('moderate');
 });
 it('resolves the test-only bare server-only alias instead of losing its consumers',()=>{
  const files=fixture();files.set('test/stubs/server-only.ts','export {};');files.set('lib/server.ts',"import 'server-only';");files.set('test/server.test.ts',"import '../lib/server';");
  expect(planImpact([change('test/stubs/server-only.ts')],files).run).toContain('test/server.test.ts');
 });
 it('is deterministic and changes its fingerprint when required coverage changes',()=>{
  const files=fixture(),c=change('lib/value.ts'),p=planImpact([c],files);expect(planImpact([c],files).fingerprint).toBe(p.fingerprint);
  files.set('test/another.test.ts',"import '../lib/value';");expect(planImpact([c],files).fingerprint).not.toBe(p.fingerprint);
 });
 it('refuses deleting tests and unresolved changed imports',()=>{
  expect(riskFor({...change('test/value.test.ts'),status:'D',headText:null}).risk).toBe('high');
  const c=change('lib/value.ts','export {};',"import './missing';");const files=fixture();files.set(c.path,c.headText!);
  expect(planImpact([c],files).tier).toBe('full');
 });
});

describe('diagnostic-only edits through pure facades',()=>{
 const setup=()=>{
  const files=new Map([
   ['lib/clock.ts',"export function clock(){throw new Error('accuracy');}"],['lib/unrelated.ts','export const unrelated=1;'],
   ['lib/service.ts',"export * from './clock';export * from './unrelated';"],
   ['test/clock.test.ts',"import {clock} from '../lib/service';"],['test/other.test.ts',"import {unrelated} from '../lib/service';"],
  ]);const c=change('lib/clock.ts',"export function clock(){throw new Error('location');}",files.get('lib/clock.ts')!);return {files,c};
 };
 it('selects the named export consumer without pulling unrelated facade consumers',()=>{
  const {files,c}=setup(),p=planImpact([c],files);expect(p.barrelMode).toBe('diagnostic-symbols');expect(p.run).toEqual(['test/clock.test.ts']);
 });
 it('retains namespace and literal-dynamic consumers',()=>{
  const {files,c}=setup();files.set('test/namespace.test.ts',"import * as service from '../lib/service';");files.set('test/dynamic.test.ts',"const service=import('../lib/service');");
  expect(planImpact([c],files).run).toEqual(['test/clock.test.ts','test/dynamic.test.ts','test/namespace.test.ts']);
 });
 it('resolves explicitly destructured literal dynamic imports without treating them as namespace consumers',()=>{
  const {files,c}=setup();files.set('test/dynamic-other.test.ts',"async function read(){const {unrelated}=await import('../lib/service');return unrelated;}");
  files.set('test/dynamic-clock.test.ts',"async function read(){const {clock:call}=await import('../lib/service');return call;}");
  const p=planImpact([c],files);expect(p.run).toContain('test/dynamic-clock.test.ts');expect(p.run).not.toContain('test/dynamic-other.test.ts');
 });
 it('recognizes named and star re-exports owned by a concrete module behind a pure facade',()=>{
  for(const exportText of ["export {helper} from './helper';","export * from './helper';"]){
   const {files,c}=setup();files.set('lib/helper.ts','export const helper=1;');
   files.set('lib/unrelated.ts','export const unrelated=1;'+exportText);
   files.set('test/helper.test.ts',"import {helper} from '../lib/service';");
   const p=planImpact([c],files);expect(p.run).toEqual(['test/clock.test.ts']);
  }
 });
 it('keeps module-wide reach for initialization or functional changes',()=>{
  const {files,c}=setup();const initialized={...c,baseText:c.baseText+'\nclock();',headText:c.headText+'\nclock();'};files.set(c.path,initialized.headText);
  const p=planImpact([initialized],files);expect(p.barrelMode).toBe('module');expect(p.run).toContain('test/other.test.ts');
  const functional={...c,headText:"export function clock(){return false;}"};files.set(c.path,functional.headText);expect(planImpact([functional],files).run).toContain('test/other.test.ts');
 });
});

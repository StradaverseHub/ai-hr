/** Source AST closure: production can mint provider dispatch only at the reviewed gateway owner. */
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {aiBoundaryViolations} from '../scripts/ai-caller-drift';
function walk(directory:string):string[]{return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):/\.[cm]?[jt]sx?$/.test(entry.name)?[join(directory,entry.name)]:[]);}
describe('provider egress issuer import closure',()=>{
 it('keeps the actual production issuer import at lib/ai/index.ts and guards every other application source',()=>{
  const files=['app','core','lib','packs','scripts'].flatMap(walk),owners:string[]=[];
  for(const file of files){const source=readFileSync(file,'utf8');
   const errors=aiBoundaryViolations(file,source).filter(message=>message.startsWith('provider egress issuer'));
   expect(errors,file).toEqual([]);
   if(file!=='lib/ai/provider-egress.ts'&&/import\s*\{[^}]*\bwithProviderEgressDispatch\b[^}]*\}\s*from\s*['"][^'"]*provider-egress['"]/.test(source))owners.push(file);
  }
  expect(owners).toEqual(['lib/ai/index.ts']);
 });
 it.each([
  "import {withProviderEgressDispatch as bypass} from '../lib/ai/provider-egress'; bypass(cfg,request,send);",
  "import * as egress from '@/lib/ai/provider-egress'; egress.withProviderEgressDispatch(cfg,request,send);",
  "import egress from '../lib/ai/provider-egress.ts'; egress(cfg,request,send);",
  "const egress=require('../lib/ai/provider-egress'); egress.withProviderEgressDispatch(cfg,request,send);",
  "const egress=await import('@/lib/ai/provider-egress'); egress.withProviderEgressDispatch(cfg,request,send);",
  "const path='../lib/ai/'+'provider-egress'; const load=require; const egress=load(path);",
  "const path='../lib/ai/'+'provider-egress'; const egress=await import(path);",
  "const load=createRequire(import.meta.url); const egress=load('../lib/ai/provider-egress');",
  "withProviderEgressDispatch(cfg,request,send);",
 ])('rejects issuer extraction in any other production caller: %s',source=>{
  for(const file of ['core/rogue.ts','app/rogue.ts','lib/rogue.ts','packs/rogue.ts','scripts/rogue.ts'])expect(aiBoundaryViolations(file,source),file).toContain('provider egress issuer outside gateway');
 });
 it.each([
  "export {withProviderEgressDispatch as bypass} from './provider-egress';",
  "export * from './provider-egress';",
  "import {withProviderEgressDispatch as mint} from './provider-egress'; export {mint};",
 ])('refuses issuer re-export even from the authorized gateway owner: %s',source=>{
  expect(aiBoundaryViolations('lib/ai/index.ts',source)).toContain('provider egress issuer re-export');
 });
 it('allows only the named issuer at the gateway, adapter consumer guards and explicit test fixtures',()=>{
  expect(aiBoundaryViolations('lib/ai/index.ts',"import {withProviderEgressDispatch} from './provider-egress'; withProviderEgressDispatch(cfg,request,send);")).toEqual([]);
  expect(aiBoundaryViolations('lib/ai/providers/openai.ts',"import {consumeProviderEgressDispatch} from '../provider-egress'; consumeProviderEgressDispatch(cfg,'draft',args);")).toEqual([]);
  expect(aiBoundaryViolations('test/helpers/provider-egress-fixture.ts',"import {withProviderEgressDispatch} from '../../lib/ai/provider-egress'; withProviderEgressDispatch(cfg,request,send);")).toEqual([]);
 });
});

describe('privacy request issuer import closure',()=>{
 const owners={bindProviderPrivacyRequest:['core/ai-governance.ts'],transferProviderPrivacyRequest:['core/ai-governance.ts','lib/ai/governance.ts'],consumeProviderPrivacyRequest:['lib/ai/index.ts'],revokeProviderPrivacyRequest:['core/ai-governance.ts']} as const;
 it('keeps every privacy request issuer in its exact production owner',()=>{
  for(const file of ['app','core','lib','packs','scripts'].flatMap(walk))expect(aiBoundaryViolations(file,readFileSync(file,'utf8')).filter(error=>error.startsWith('provider privacy issuer')),file).toEqual([]);
 });
 it.each(Object.keys(owners) as (keyof typeof owners)[])('rejects named and aliased %s imports/calls outside its owner',name=>{
  const source=`import {${name} as bypass} from '../lib/ai/provider-privacy-request'; bypass(value);`;
  for(const file of ['core/rogue.ts','lib/rogue.ts','app/rogue.ts','packs/rogue.ts','scripts/rogue.ts'])expect(aiBoundaryViolations(file,source)).toContain('provider privacy issuer outside owner');
  for(const file of owners[name])expect(aiBoundaryViolations(file,source)).toEqual([]);
  expect(aiBoundaryViolations('test/helpers/privacy-fixture.ts',source)).toEqual([]);
 });
 it.each([
  "import * as privacy from '../lib/ai/provider-privacy-request';",
  "const privacy=require('../lib/ai/provider-privacy-request');",
  "const modulePath='../lib/ai/'+'provider-privacy-request'; const load=require; const privacy=load(modulePath);",
  "const privacy=await import('../lib/ai/provider-privacy-request');",
  "const modulePath='../lib/ai/'+'provider-privacy-request'; const privacy=await import(modulePath);",
 ])('refuses namespace and indirect module extraction even at one partial owner: %s',source=>{
  for(const file of ['core/ai-governance.ts','lib/ai/governance.ts','lib/ai/index.ts','core/rogue.ts'])expect(aiBoundaryViolations(file,source)).toContain('provider privacy issuer outside owner');
 });
 it.each([
  "export * from './provider-privacy-request';",
  "export {bindProviderPrivacyRequest as bypass} from './provider-privacy-request';",
  "import {consumeProviderPrivacyRequest as consume} from './provider-privacy-request'; export {consume};",
 ])('refuses privacy issuer export barrels: %s',source=>expect(aiBoundaryViolations('lib/ai/index.ts',source)).toContain('provider privacy issuer re-export'));
 it('allows the non-issuing assertion without granting request custody or transfer',()=>{
  expect(aiBoundaryViolations('core/consumer.ts',"import {assertProviderPrivacyRequest} from '../lib/ai/provider-privacy-request'; assertProviderPrivacyRequest(cfg,args);")).toEqual([]);
  expect(aiBoundaryViolations('lib/ai/index.ts',"import {bindProviderPrivacyRequest} from './provider-privacy-request';")).toContain('provider privacy issuer outside owner');
  expect(aiBoundaryViolations('core/ai-governance.ts',"import {consumeProviderPrivacyRequest} from '../lib/ai/provider-privacy-request';")).toContain('provider privacy issuer outside owner');
 });
});

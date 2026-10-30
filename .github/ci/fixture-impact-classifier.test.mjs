/** Hosted parser-backed positive and refusal controls for the separate finite classifier. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planImpact,isPinnedTimingWriter,readsOnlyProcessStatus} from './fixture-impact-classifier.ts';
import {planImpact as originalPlanImpact} from '../../scripts/gate-impact.ts';
const profile=readFileSync(new URL('../../test/profile.ts',import.meta.url),'utf8');
const change=(path,baseText,headText)=>({path,status:'M',baseText,headText});
function graph(helper='test/profile.ts',text=profile){
 const before='export const value=1;',after='export const value=2;';
 return {changes:[change('core/example.ts',before,after)],files:new Map([
  ['core/example.ts',after],['test/example.test.ts',"import {value} from '../core/example'; console.log(value);"],
  [helper,text],['test/unrelated.test.ts',`import * as helper from './${helper.slice(5,-3)}'; console.log(helper);`],
 ])};
}
test('Only the unchanged exact reviewed timing writer loses its false repository-reader edge',()=>{
 const {changes,files}=graph(),old=originalPlanImpact(changes,files),fresh=planImpact(changes,files);
 assert(old.run.includes('test/unrelated.test.ts'));assert(!fresh.run.includes('test/unrelated.test.ts'));assert(fresh.run.includes('test/example.test.ts'));assert.equal(fresh.policyVersion,4);assert.equal(fresh.tier,'impact');
 assert(isPinnedTimingWriter('test/profile.ts',profile));assert(!isPinnedTimingWriter('test/other.ts',profile));assert(!isPinnedTimingWriter('test/profile.ts',profile+'\n'));
});
for(const [name,path,text] of [['changed writer bytes','test/profile.ts',profile+'\n'],['different writer path','test/other.ts',profile],['arbitrary reader','test/profile.ts',"import {readFileSync} from 'node:fs';export const value=readFileSync('source.ts');"]])test('Writer boundary stays conservative for '+name,()=>{
 const {changes,files}=graph(path,text);assert(planImpact(changes,files).run.includes('test/unrelated.test.ts'));
});
const proc="import {readFile} from 'node:fs/promises';export async function rss(){return readFile('/proc/self/status','utf8');}";
test('Unchanged proven process-status reads do not invalidate unrelated repository consumers',()=>{
 assert(readsOnlyProcessStatus('test/monitor.ts',proc));const {changes,files}=graph('test/monitor.ts',proc);
 assert(originalPlanImpact(changes,files).run.includes('test/unrelated.test.ts'));assert(!planImpact(changes,files).run.includes('test/unrelated.test.ts'));
});
test('Unknown or changed process readers retain conservative selection',()=>{
 for(const text of [proc.replace('/proc/self/status','/etc/passwd'),proc.replace("'/proc/self/status'",'process.env.PATH')]){
  assert(!readsOnlyProcessStatus('test/monitor.ts',text));const {changes,files}=graph('test/monitor.ts',text);assert(planImpact(changes,files).run.includes('test/unrelated.test.ts'));
 }
 const {changes,files}=graph('test/monitor.ts',proc);changes.push(change('test/monitor.ts',proc+'\n',proc));assert(planImpact(changes,files).run.includes('test/unrelated.test.ts'));
});
test('Known browser leaves require fresh browser coverage without masquerading as orphaned Node helpers',()=>{
 const path='test/header.browser.test.tsx',before="export const shell='flex';",after="export const shell='flex min-w-0';",files=new Map([[path,after],['test/authz.test.ts','export const value=1;']]),changes=[change(path,before,after)];
 assert.equal(originalPlanImpact(changes,files).tier,'full');const p=planImpact(changes,files);assert.equal(p.tier,'impact');assert.equal(p.browser,true);assert(p.run.includes('test/authz.test.ts'));
});
for(const [name,path,text] of [['unrecognized helper','test/header.tsx',"export const shell='flex min-w-0';"],['unresolved browser import','test/header.browser.test.tsx',"import './missing';export const shell='flex min-w-0';"],['unparseable browser','test/header.browser.test.tsx','export const = ;']])test('Browser boundary refuses '+name,()=>{
 const files=new Map([[path,text],['test/example.test.ts','export const value=1;']]);assert.equal(planImpact([change(path,"export const shell='flex';",text)],files).tier,'full');
});

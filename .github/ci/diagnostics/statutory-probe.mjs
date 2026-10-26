/** Diagnostic only: unchanged source first, then labelled timing instrumentation; no release receipt. */
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||process.platform!=='linux')throw Error('Disposable Linux CI only');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim(),sha=git('rev-parse','HEAD');
if(sha!=='ba2142efbc2e181134d30d1e45740a36d55e29e8'||git('status','--porcelain'))throw Error('Unchanged frozen original required');
const original='test/15e5bd93-statutory-screen.dom.test.tsx',source=readFileSync(original,'utf8');
const out=join(process.env.RUNNER_TEMP,'statutory-diagnostic');mkdirSync(out,{recursive:true});mkdirSync('.vitest-attachments',{recursive:true});
const hash=s=>createHash('sha256').update(s).digest('hex');
const run=(kind,file,config)=>{
 const start=Date.now();const result=spawnSync('pnpm',['exec','vitest','run','--config',config,file,'--reporter=default','--reporter=json','--outputFile.json='+join(out,kind+'.json')],{encoding:'utf8',timeout:240000,maxBuffer:64*1024*1024,env:{...process.env,VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2'}});
 const log=(result.stdout??'')+(result.stderr??'');writeFileSync(join(out,kind+'.log'),log,{flag:'wx'});
 const report={kind:'DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE',source:sha,controller:process.env.AIHR_CI_CONTROL_HEAD,probe:kind,elapsedMs:Date.now()-start,exitCode:result.status,signal:result.signal,childError:String(result.error??''),testTimeoutMs:5000};
 writeFileSync(join(out,kind+'-execution.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
 const raw=JSON.parse(readFileSync(join(out,kind+'.json'),'utf8'));if(raw.testResults.length!==1||raw.numTotalTests!==36)throw Error('Original 36-case inventory not executed');
 return raw.testResults[0].assertionResults.map(t=>t.fullName).sort();
};
const names=run('original',original,'vitest.nodb.config.ts');
let measured=source.replace("import { render, screen, waitFor, within } from '@testing-library/react';","import { render, screen as __screen, waitFor as __waitFor, within as __within } from '@testing-library/react';");
if(measured===source)throw Error('Expected Testing Library import absent');
measured=measured.replace('function mountScreen(', 'function __originalMountScreen(').replaceAll('userEvent.setup(', '__diagUser(');
const instrumentation=`
// LABELLED MEASUREMENT COPY: original assertions, event semantics and 5000ms deadline retained.
let __metrics:any=null;
function __record(label:string,start:number){if(!__metrics)return;const d=performance.now()-start;const r=__metrics.stages[label]??{calls:0,totalMs:0,maxMs:0};r.calls++;r.totalMs+=d;r.maxMs=Math.max(r.maxMs,d);__metrics.stages[label]=r;}
function __sync<T>(label:string,fn:()=>T):T{const start=performance.now();try{return fn();}finally{__record(label,start);}}
async function __async<T>(label:string,fn:()=>Promise<T>):Promise<T>{const start=performance.now();try{return await fn();}finally{__record(label,start);}}
function __proxy(target:any,prefix:string){return new Proxy(target,{get(obj,key){const value=Reflect.get(obj,key);if(typeof value!=='function')return value;return (...args:any[])=>String(key).startsWith('find')||prefix==='userEvent'?__async(prefix+'.'+String(key),()=>value.apply(obj,args)):__sync(prefix+'.'+String(key),()=>value.apply(obj,args));}});}
const screen=__proxy(__screen,'screen');
const within=(...args:Parameters<typeof __within>)=>__proxy(__within(...args),'within');
const waitFor=(...args:Parameters<typeof __waitFor>)=>__async('waitFor',()=>__waitFor(...args));
function __diagUser(...args:Parameters<typeof userEvent.setup>){return __proxy(userEvent.setup(...args),'userEvent');}
function mountScreen(over:Record<string,unknown>={},save?:(fd:FormData)=>Promise<TabSaveResult>){const observed=save?((fd:FormData)=>__async('save-callback',()=>save(fd))):save;return __sync('mount',()=>__originalMountScreen(over,observed));}
const __windowStyle=window.getComputedStyle;
window.getComputedStyle=function(...args:Parameters<typeof window.getComputedStyle>){return __sync('window.getComputedStyle',()=>__windowStyle.apply(window,args));};
const __globalStyle=globalThis.getComputedStyle;
if(__globalStyle!==window.getComputedStyle)globalThis.getComputedStyle=function(...args:Parameters<typeof globalThis.getComputedStyle>){return __sync('global.getComputedStyle',()=>__globalStyle.apply(globalThis,args));};
beforeEach(()=>{__metrics={case:expect.getState().currentTestName,start:performance.now(),stages:{}};push.mockImplementation(()=>{__sync('navigation-callback',()=>undefined);});});
afterEach(()=>{console.log('AIHR_STATUTORY_PROFILE '+JSON.stringify({...__metrics,elapsedMs:performance.now()-__metrics.start,note:'Inclusive nested stage timings; instrumentation overhead and post-timeout work may affect observations.'}));__metrics=null;});
`;
// Imports/hoisted mocks collect normally; these extra root hooks register after originals.
measured+='\n'+instrumentation;
const copy='.vitest-attachments/statutory-measured.dom.test.tsx';writeFileSync(copy,measured,{flag:'wx'});
const config='.vitest-attachments/statutory-measured.config.mts';
writeFileSync(config,"import base from '../vitest.nodb.config';\nexport default {...base,test:{...base.test,projects:base.test.projects.map(p=>({...p,test:{...p.test,include:p.test.name==='dom'?[...p.test.include,'.vitest-attachments/statutory-measured.dom.test.tsx']:p.test.include}}))}};\n",{flag:'wx'});
writeFileSync(join(out,'provenance.json'),JSON.stringify({kind:'LABELLED_DIAGNOSTIC_NOT_RELEASE_EVIDENCE',sha,original,originalSha256:hash(source),copySha256:hash(measured),assertionsChanged:false,timeoutChanged:false,workers:2},null,2)+'\n',{flag:'wx'});
const measuredNames=run('instrumented',copy,config);
if(JSON.stringify(names)!==JSON.stringify(measuredNames))throw Error('Measurement changed case inventory');
if(git('rev-parse','HEAD')!==sha||git('status','--porcelain'))throw Error('Original source changed');

/** DRAFT: generate ignored diagnostic copies only; original assertions/timeouts retained. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const source=process.cwd(),out=join(source,'.vitest-attachments');mkdirSync(out,{recursive:true});
const modify=(name,edit)=>{const original=readFileSync(join(source,'test',name),'utf8');const changed=edit(original);if(changed===original)throw Error('No instrumentation landed: '+name);writeFileSync(join(out,'diag-'+name),changed,{flag:'wx'});};
modify('personnel-import-exclusions.test.ts',s=>{
 const needle="JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'))";
 if(!s.includes(needle))throw Error('Catalog instrumentation marker absent');
 return `import {afterEach as __diagAfterEach} from 'vitest';
const __diagMetrics={calls:0,bytes:0,readMs:0,parseMs:0};
function __diagRead(locale:string){const start=performance.now();const bytes=readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8');const readEnd=performance.now();const value=JSON.parse(bytes);__diagMetrics.calls++;__diagMetrics.bytes+=Buffer.byteLength(bytes);__diagMetrics.readMs+=readEnd-start;__diagMetrics.parseMs+=performance.now()-readEnd;return value;}
__diagAfterEach(()=>console.log('AIHR_CATALOG_TIMING '+JSON.stringify(__diagMetrics)));
`+s.split(needle).join('__diagRead(locale)');
});
modify('employee-import-screen.dom.test.tsx',s=>{
 const callback='captured = blob;';const click="screen.getByRole('button', { name: 'Download Excel template' }).click();";
 if(!s.includes(callback)||!s.includes(click))throw Error('Download instrumentation markers absent');
 return `import {afterAll as __diagAfterAll} from 'vitest';
const __diagStart=performance.now();let __diagClick:number|null=null;let __diagCallback:number|null=null;
__diagAfterAll(async()=>{if(__diagClick!==null&&__diagCallback===null)await new Promise(r=>setTimeout(r,15000));console.log('AIHR_DOWNLOAD_OBSERVATION_END '+JSON.stringify({clickMs:__diagClick,callbackMs:__diagCallback,elapsedMs:performance.now()-__diagStart}));});
`+s.replace(callback,"__diagCallback=performance.now();console.log('AIHR_DOWNLOAD_CALLBACK '+JSON.stringify({sinceClickMs:__diagClick===null?null:__diagCallback-__diagClick,blobBytes:blob.size})); "+callback).replace(click,"__diagClick=performance.now();console.log('AIHR_DOWNLOAD_CLICK '+JSON.stringify({sinceImportMs:__diagClick-__diagStart})); "+click);
});
modify('cost-center-allocations.dom.test.tsx',s=>{
 const click="fireEvent.click(screen.getByRole('button',{name:'Confirm and save'}));";
 if(!s.includes(click))throw Error('Confirm instrumentation marker absent');
 return `function __diagObserveConfirm(button:HTMLButtonElement){console.log('AIHR_CONFIRM_BEFORE_CLICK '+JSON.stringify({time:performance.now(),disabled:button.disabled,html:button.outerHTML}));const observer=new MutationObserver(()=>console.log('AIHR_CONFIRM_DISABLED_TRANSITION '+JSON.stringify({time:performance.now(),disabled:button.disabled,connected:button.isConnected})));observer.observe(button,{attributes:true,attributeFilter:['disabled']});setTimeout(()=>{console.log('AIHR_CONFIRM_LATER '+JSON.stringify({time:performance.now(),disabled:button.disabled,connected:button.isConnected}));observer.disconnect();},1500);}
`+s.split(click).join(`__diagObserveConfirm(screen.getByRole('button',{name:'Confirm and save'}) as HTMLButtonElement);${click}`);
});
const base="import base from '../vitest.nodb.config';\n";
writeFileSync(join(out,'diagnostic-nodb.config.mts'),base+`export default {...base,test:{...base.test,projects:base.test.projects.map(p=>({...p,test:{...p.test,globalSetup:[],maxWorkers:1,include:[p.test.name==='node'?'.vitest-attachments/*.test.ts':'.vitest-attachments/*.dom.test.tsx']}}))}};\n`,{flag:'wx'});

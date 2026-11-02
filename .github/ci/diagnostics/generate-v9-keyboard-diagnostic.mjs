/** Hosted diagnosis only. Keep the tracked candidate untouched and measure its exact Firefox workload. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {closeSync,createReadStream,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {createPlan} from '../plan.mjs';
import {hostHealth} from '../host-health.mjs';

const candidate='a02845ba82a530ddd264f6eff1466bc106704052';
const baseline='dfbcf85b1f03e6e3266df6244694079a98e17dc9';
const target='test/lifecycle-v9-html-gaps.browser.test.tsx';
const baseConfig='vitest.browser.config.ts';
const measured='.vitest-attachments/v9-keyboard-measured.browser.test.tsx';
const config='.vitest-attachments/v9-keyboard-diagnostic.config.mts';
const helper='.vitest-attachments/helpers/v9-html-fixture.ts';
const title='repairs reference details, keyboard sections, notice and duplicate chrome in monolith dark mobile';
const marker='V9_KEYBOARD_DIAGNOSTIC ';
const kind='V9_KEYBOARD_MEASUREMENT_ONLY';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const snapshot=path=>({path,blob:git('hash-object',path),sha256:hash(readFileSync(path))});
const write=(path,value)=>writeFileSync(path,value,{flag:'wx',mode:0o600});
const json=(path,value)=>write(path,JSON.stringify(value,null,2)+'\n');
const trackedClean=()=>assert.equal(git('status','--porcelain'),'','Tracked source or unignored artifacts changed');

assert(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','Hosted diagnostic only');
assert(process.platform==='linux'&&process.arch==='x64'&&process.versions.node==='22.23.3','Exact Firefox runtime required');
assert(process.env.ENGINE==='firefox'&&process.env.PLAYWRIGHT_BROWSERS_PATH==='/ms-playwright'
 &&process.env.TZ==='Asia/Kuala_Lumpur'&&process.env.LANG==='en_US.UTF-8','Exact Firefox environment required');
assert(git('rev-parse','HEAD')===candidate&&process.env.AIHR_CI_HEAD===candidate
 &&process.env.AIHR_CI_MIGRATION_BASE===baseline,'Exact original diagnostic source and baseline required');
assert.equal(process.argv.length,3,'One evidence directory required');
const destination=resolve(process.argv[2]),scratch=resolve(process.env.RUNNER_TEMP);
assert(relative(scratch,destination)==='v9-keyboard-evidence','Expected owned diagnostic artifact directory');
trackedClean();
mkdirSync(destination);
const originalTest=snapshot(target),originalConfig=snapshot(baseConfig);
assert.equal(originalTest.blob,'1625e4c9c9fa1c2f606e669e536ee4b84b619ce8');
assert.equal(originalConfig.blob,'2643f42716a47d4862cd18e4bcf283aadc703c3f');

const plan=createPlan(),unit=plan.units.find(row=>row.id==='browser-firefox');
assert(unit?.kind==='browser'&&unit.engine==='firefox'&&plan.execution.workers===2&&unit.files.length===35,'Original Firefox execution profile required');
assert.equal(hash(JSON.stringify(unit.files)),'d0a7af6abe9e5818f018dd62c29038bf18e4db6cb4cbf79dff735ad61798cbf1','Original ordered Firefox file inventory required');
const files=unit.files.map(file=>file===target?measured:file);

// Adapt the earlier passive capture/bubble observer to this incident's first Enter only.
const observer=String.raw`
function observeAssignmentRulesEnter(selected:HTMLElement){
 const events:Record<string,unknown>[]=[], ids=new WeakMap<Element,number>();
 let sequence=0,dropped=0;
 const current=()=>document.querySelector<HTMLElement>('button[aria-label="Assignment rules"]');
 const identify=(value:EventTarget|null)=>{
  if(!(value instanceof Element))return null;
  if(!ids.has(value))ids.set(value,++sequence);
  return {node:ids.get(value),tag:value.tagName,label:value.getAttribute('aria-label')?.slice(0,80)??null,connected:value.isConnected};
 };
 const record=(phase:string,event?:Event,oldExpanded?:string|null)=>{
  if(events.length>=96){dropped++;return;}
  const button=current();
  let parentFrame:unknown=null;
  try{
   const parentActive=window.parent.document.activeElement;
   parentFrame={tag:parentActive?.tagName??null,ownsFocus:parentActive===window.frameElement,inFrame:window.parent!==window};
  }catch{parentFrame='unavailable';}
  events.push({phase,at:performance.now(),documentFocused:document.hasFocus(),visibility:document.visibilityState,
   parentFrame,active:identify(document.activeElement),selected:identify(selected),current:identify(button),sameCurrent:selected===button,
   expanded:selected.getAttribute('aria-expanded'),currentExpanded:button?.getAttribute('aria-expanded')??null,
   disabled:selected.hasAttribute('disabled'),oldExpanded,
   ...(event?{type:event.type,target:identify(event.target),isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented,
    key:event instanceof KeyboardEvent?event.key:null,code:event instanceof KeyboardEvent?event.code:null,repeat:event instanceof KeyboardEvent?event.repeat:null}:{}),
  });
 };
 const capture=(event:Event)=>record('capture',event),bubble=(event:Event)=>record('bubble',event);
 const windowFocus=(event:Event)=>record('window-focus',event);
 const types=['focusin','focusout','keydown','keyup','click'];
 for(const type of types){
  document.addEventListener(type,capture,{capture:true,passive:true});
  document.addEventListener(type,bubble,{passive:true});
 }
 window.addEventListener('focus',windowFocus);
 window.addEventListener('blur',windowFocus);
 let last=current();
 const observer=new MutationObserver(changes=>{
  const next=current();
  if(next!==last){record('button-replaced');last=next;}
  for(const change of changes)if(change.type==='attributes'&&(change.target===selected||change.target===next))record('aria-expanded-mutation',undefined,change.oldValue);
 });
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded'],attributeOldValue:true});
 record('before-existing-focus');
 return {record,finish:()=>{
  record('after-existing-assertion');
  observer.disconnect();
  for(const type of types){document.removeEventListener(type,capture,true);document.removeEventListener(type,bubble);}
  window.removeEventListener('focus',windowFocus);window.removeEventListener('blur',windowFocus);
  console.info('V9_KEYBOARD_DIAGNOSTIC '+JSON.stringify({kind:'V9_KEYBOARD_MEASUREMENT_ONLY',theme:'monolith',dark:true,mobile:true,route:'onbChecklists',events,dropped}));
 }};
}
`;
function replaceExactly(source,needle,replacement){
 assert.equal(source.split(needle).length,2,'Expected one byte-pinned insertion point');
 return source.replace(needle,()=>replacement);
}
const loop="for(const theme of ['classic','monolith','atelier'] as const)";
const enter="   rules.focus();await expect.poll(()=>document.activeElement).toBe(rules);await userEvent.keyboard('{Enter}');\n";
const assertion="   const rulesAtKeyReturn=rules.getAttribute('aria-expanded');await expect.poll(()=>rules.getAttribute('aria-expanded')).toBe('true');expect(screen.getByText(/Population preview/)).toBeVisible();\n";
let source=replaceExactly(readFileSync(target,'utf8'),loop,observer+loop);
source=replaceExactly(source,enter+assertion,
 "   const observation=theme==='monolith'&&dark&&mobile&&route==='onbChecklists'?observeAssignmentRulesEnter(rules):null;\n   let rulesAtKeyReturn:string|null;\n   try{\n"
 +enter.replace("await userEvent.keyboard('{Enter}');","observation?.record('before-existing-enter');await userEvent.keyboard('{Enter}');observation?.record('after-existing-enter');")
 +assertion.replace('const rulesAtKeyReturn=','rulesAtKeyReturn=')
 +"   }finally{observation?.finish();}\n");
mkdirSync('.vitest-attachments/helpers',{recursive:true});
write(measured,source);
write(helper,"export * from '../../test/helpers/v9-html-fixture';\n");
write(config,`import base from '../vitest.browser.config';\nexport default {...base,test:{...base.test,include:[...base.test.include,${JSON.stringify(measured)}],browser:{...base.test.browser,instances:[{browser:'firefox'}]}}};\n`);

const healthBefore=hostHealth();
const provenance={kind,releaseAuthorized:false,candidate,baseline,controller:process.env.AIHR_CI_CONTROL_HEAD,
 runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,engine:'firefox',workers:plan.execution.workers,
 originalTest,originalConfig,measuredSha256:hash(source),configSha256:hash(readFileSync(config)),helperSha256:hash(readFileSync(helper)),
 originalFiles:unit.files,measurementFiles:files,healthBefore};
json(join(destination,'measurement-inputs.json'),provenance);
assert(healthBefore.ok,'Original disk admission guard refused diagnostic');

const report=join(scratch,'v9-keyboard-vitest.json'),log=join(scratch,'v9-keyboard-process.log');
const env={...process.env,VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2',AIHR_BROWSER_ENGINE:'firefox',AIHR_TEST_DURATION_ORDER:'false'};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])env[key]='postgres://nobody:nothing@127.0.0.1:1/no_database';
const fd=openSync(log,'wx',0o600);
let child;
try{
 child=spawnSync('pnpm',['exec','vitest','run','--config',config,...files,'--reporter=default','--reporter=json','--outputFile.json='+report],{env,stdio:['ignore',fd,fd]});
}finally{closeSync(fd);}
json(join(destination,'measurement-process.json'),{kind,releaseAuthorized:false,exitCode:child.status,signal:child.signal,spawnError:child.error?.code??null,healthAfter:hostHealth()});

let traces=0;
for await(const line of createInterface({input:createReadStream(log),crlfDelay:Infinity})){
 const start=line.indexOf(marker);
 if(start===-1||line.length-start>128*1024)continue;
 const data=JSON.parse(line.slice(start+marker.length));
 assert(data.kind===kind&&data.route==='onbChecklists'&&Array.isArray(data.events)&&data.events.length<=96,'Unexpected diagnostic trace');
 assert.equal(++traces,1,'Duplicate measurement trace');
 json(join(destination,'keyboard-trace.json'),data);
}
function retainBounded(path,name,max){
 const stat=lstatSync(path,{throwIfNoEntry:false});
 if(!stat?.isFile()||stat.size>max)return false;
 write(join(destination,name),readFileSync(path));
 return true;
}
const retainedReport=retainBounded(report,'measurement-vitest.json',4*1024*1024);
const result=retainedReport?JSON.parse(readFileSync(report,'utf8')):null;
const observedFiles=result?.testResults?.map(file=>relative(process.cwd(),file.name)).sort()??[];
const observedExactFiles=JSON.stringify(observedFiles)===JSON.stringify([...files].sort());
const targetResult=result?.testResults?.find(file=>relative(process.cwd(),file.name)===measured);
const targetStatus=targetResult?.assertionResults?.find(item=>item.fullName===title)?.status??null;
const failurePng='.vitest-attachments/__screenshots__/v9-keyboard-measured.browser.test.tsx/'
 +title.replaceAll(/[^a-zA-Z0-9_-]/g,'-')+'-1.png';
const retainedScreenshot=child.status!==0&&retainBounded(failurePng,'measurement-failure.png',2*1024*1024);
trackedClean();
assert.deepEqual(snapshot(target),originalTest);
assert.deepEqual(snapshot(baseConfig),originalConfig);
json(join(destination,'measurement-summary.json'),{kind,releaseAuthorized:false,traces,retainedReport,retainedScreenshot,observedExactFiles,reportedCases:result?.numTotalTests??null,targetStatus});
console.info(JSON.stringify({kind,exitCode:child.status,traces,retainedReport,retainedScreenshot}));
process.exitCode=child.status===0?(!traces||!retainedReport||!observedExactFiles?1:0):(child.status??1);

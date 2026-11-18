/** Pure prerequisite selection and actual workflow wiring; no application or package installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {systemLabelFontsRequired} from './system-label-fonts.mjs';
import {bootstrapFixedNoto,assertFixedNotoRunner} from './fixed-noto-bootstrap.mjs';

const consumer='test/system-label-exchange-browser.test.ts',other='test/plain.test.ts';
const expected={candidate:'a'.repeat(40),controller:'c'.repeat(40)};
function fixture(){return {sha:expected.candidate,controller:expected.controller,suite:[consumer,other],units:[
 {id:'db-selected',kind:'db',files:[consumer]},
 {id:'nodb-other',kind:'nodb',files:[other]},
]};}
test('only the exact complete unit containing System Labels needs the fonts',()=>{
 const plan=fixture();assert.equal(systemLabelFontsRequired(plan,'db-selected',expected),true);
 assert.equal(systemLabelFontsRequired(plan,'nodb-other',expected),false);
 assert.equal(systemLabelFontsRequired({...plan,units:[{id:'nodb-selected',kind:'nodb',files:[other,consumer]}]},'nodb-selected',expected),true);
});
test('a related name, unit id or different file never selects fonts',()=>{
 for(const file of ['test/system-label-exchange-browser-extra.test.ts','test/system-label-exchange-browser.test.tsx','test/other.test.ts']){
  const plan={...fixture(),suite:[file],units:[{id:'db-system-label-exchange-browser',kind:'db',files:[file]}]};
  assert.equal(systemLabelFontsRequired(plan,'db-system-label-exchange-browser',expected),false);
 }
});
test('stale, absent or malformed candidate/controller identity refuses before selection',()=>{
 for(const change of [{sha:'b'.repeat(40)},{controller:'d'.repeat(40)},{sha:undefined},{controller:undefined}])
  assert.throws(()=>systemLabelFontsRequired({...fixture(),...change},'db-selected',expected));
 for(const change of [{candidate:''},{controller:''},{candidate:'main'},{controller:'c'.repeat(39)}])
  assert.throws(()=>systemLabelFontsRequired(fixture(),'db-selected',{...expected,...change}));
});
test('unknown, duplicate, browser or malformed units cannot produce a font decision',()=>{
 assert.throws(()=>systemLabelFontsRequired(fixture(),'unknown',expected));
 assert.throws(()=>systemLabelFontsRequired(fixture(),'',expected));
 for(const unit of [{id:'db-selected',kind:'browser',files:[consumer]},{id:'db-selected',kind:'db',files:[]},
  {id:'db-selected',kind:'db',files:[consumer,consumer]},{id:'db-selected',kind:'db',files:['test/foreign.test.ts']},
  {id:'db-selected',kind:'db',files:null},{id:'db-selected',kind:'db',files:[null]}])
  assert.throws(()=>systemLabelFontsRequired({...fixture(),units:[unit]},'db-selected',expected));
 const plan=fixture();plan.units.push({...plan.units[0]});assert.throws(()=>systemLabelFontsRequired(plan,'db-selected',expected));
 for(const plan of [null,{...fixture(),suite:null},{...fixture(),units:null}])
  assert.throws(()=>systemLabelFontsRequired(plan,'db-selected',expected));
});

const workflow=name=>readFileSync(new URL(`../workflows/${name}`,import.meta.url),'utf8');
const bootstrap='node ../automation/.github/ci/fixed-noto-bootstrap.mjs';
test('focused fonts preserve the four existing consumers and add only the exact System Labels path',()=>{
 const text=workflow('alpha-focused-checks.yml');
 const start=text.indexOf('      - name: Provision multilingual fonts for AI review screenshots');
 const end=text.indexOf('      - name: Classify and execute only selected files',start);
 assert(start>0&&end>start);const step=text.slice(start,end);
 const paths=[...step.matchAll(/contains\(inputs\.selected_tests, '([^']+)'\)/g)].map(match=>match[1]);
 assert.deepEqual(paths,['test/ai-management-naming.dom.test.tsx','test/ai-probe-history-page.dom.test.tsx',
  'test/feedback-kanban.dom.test.tsx','test/security-center-sidebar.dom.test.tsx',consumer]);
 assert(step.includes(bootstrap+' "$RUNNER_TEMP/aihr-focused/noto-font-setup.json"'));assert(!step.includes('apt-get'));assert(!/continue-on-error|always\(\)/.test(step));
});
test('full fonts use the trusted current unit output before headroom admission and actual execution',()=>{
 const text=workflow('alpha-staging.yml'),start=text.indexOf('      - name: Select System Labels fonts for this complete unit');
 const fonts=text.indexOf('      - name: Provision System Labels multilingual fonts before tests',start);
 const headroom=text.indexOf('      - name: Preserve suite headroom after PDF tooling',fonts);
 const run=text.indexOf('      - run: node ../automation/.github/ci/run-unit.mjs',headroom);
 assert(start>0&&fonts>start&&headroom>fonts&&run>headroom);
 const selector=text.slice(start,fonts),install=text.slice(fonts,headroom);
 assert(selector.includes('id: system-label-fonts'));
 assert(selector.includes('run: node ../automation/.github/ci/system-label-fonts.mjs "$UNIT"'));
 assert(selector.includes("env: {UNIT: '${{ matrix.unit }}'}"));
 assert(install.includes("if: ${{ steps.system-label-fonts.outputs.required == 'true' }}"));
 assert(install.includes(bootstrap+' "$RUNNER_TEMP/aihr-ci/noto-font-setup.json"'));assert(!install.includes('apt-get'));assert(!/continue-on-error|always\(\)/.test(install));
 assert.equal((text.match(/fixed-noto-bootstrap\.mjs/g)??[]).length,1);
});
test('both actual resolver control lists execute these prerequisite controls',()=>{
 for(const name of ['alpha-focused-checks.yml','alpha-staging.yml']){
  const text=workflow(name),start=text.indexOf('\n  resolve:');
  const next=text.indexOf(name==='alpha-focused-checks.yml'?'\n  selected-tests:':'\n  typecheck:',start);
  assert(start>0&&next>start);assert(text.slice(start,next).includes('.github/ci/system-label-fonts.test.mjs'));
 }
});

const commandResult=(status,extra={})=>({status,signal:null,errorCode:null,stdout:'',stderr:'',elapsedMs:1,...extra});
test('fixed Noto first uses existing indexes, without refreshing an already successful install',()=>{
 const calls=[];const proof=bootstrapFixedNoto({run:(file,args,timeout)=>{calls.push({file,args,timeout});return commandResult(0);}});
 assert.equal(calls.length,1);assert.equal(calls[0].file,'sudo');assert.equal(calls[0].timeout,128000);
 assert.deepEqual(calls[0].args.slice(-5),['install','-y','--no-install-recommends','fonts-noto-core','fonts-noto-cjk']);
 assert(calls[0].args.includes('Acquire::Retries=0'));assert(calls[0].args.includes('Acquire::http::Timeout=20'));
 assert(calls[0].args.includes('Acquire::https::Timeout=20'));assert(calls[0].args.includes('DPkg::Lock::Timeout=15'));
 assert(calls[0].args.includes('120s'));assert(calls[0].args.includes('--kill-after=5s'));
 assert.equal(proof.indexesRefreshed,false);assert.equal(proof.aggregateCommandBudgetSeconds,360);assert.equal(proof.releaseAuthorized,false);
});
test('one ordinary install failure allows one bounded refresh and one identical install retry',()=>{
 const calls=[],statuses=[100,0,0],rows=[];
 const proof=bootstrapFixedNoto({run:(file,args,timeout)=>{calls.push({file,args,timeout});return commandResult(statuses.shift());},onStep:row=>rows.push(row)});
 assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[2]);assert(calls[1].args.includes('update'));
 assert(calls[1].args.includes('APT::Update::Error-Mode=any'));assert(calls.every(call=>call.timeout===128000));
 assert.deepEqual(rows.map(row=>row.phase),['install-existing-indexes','refresh-indexes','install-after-refresh']);
 assert.equal(proof.indexesRefreshed,true);assert.deepEqual(proof.packages,['fonts-noto-core','fonts-noto-cjk']);
});
test('failed refresh or failed one retry refuses with original phase diagnostics and no loop',()=>{
 for(const statuses of [[100,100],[100,0,100]]){
  let calls=0;const rows=[];
  assert.throws(()=>bootstrapFixedNoto({run:()=>commandResult(statuses[calls++],{stderr:'x'.repeat(9000)}),onStep:row=>rows.push(row)}));
  assert.equal(calls,statuses.length);assert(rows.every(row=>row.stderr.length===8192));
 }
});
test('timeout, signal, uncertain cleanup and malformed outcome refuse before another APT process',()=>{
 for(const outcome of [commandResult(null),commandResult(-1),commandResult(256),...[1,124,125,126,127,130,137,143].map(status=>commandResult(status)),commandResult(null,{signal:'SIGKILL'}),
  commandResult(null,{errorCode:'ETIMEDOUT'}),commandResult('0')]){
  let calls=0;const rows=[];let failure;
  try{bootstrapFixedNoto({run:()=>{calls++;return outcome;},onStep:row=>rows.push(row)});}catch(error){failure=error;}
  assert(failure);assert.equal(calls,1);assert.equal(rows.length,1);assert.equal(failure.fontSetupSteps.length,1);
  assert.equal(rows[0].phase,'install-existing-indexes');assert.equal(rows[0].status,outcome.status);
  assert.equal(rows[0].signal,outcome.signal);assert.equal(rows[0].errorCode,outcome.errorCode);
  assert.deepEqual(failure.fontSetupSteps,rows);
 }
});
test('only the same disposable source-bound repository runner can execute font mutation',()=>{
 const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',
  GITHUB_REPOSITORY_ID:'1333414856',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40)};
 assert.doesNotThrow(()=>assertFixedNotoRunner(env,'linux'));
 for(const change of [{GITHUB_ACTIONS:'false'},{CI:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REPOSITORY:'foreign/repo'},
  {GITHUB_REPOSITORY_ID:'1'},{AIHR_CI_HEAD:'main'},{AIHR_CI_CONTROL_HEAD:undefined}])assert.throws(()=>assertFixedNotoRunner({...env,...change},'linux'));
 assert.throws(()=>assertFixedNotoRunner(env,'darwin'));
});

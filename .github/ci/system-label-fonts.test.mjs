/** Pure prerequisite selection and actual workflow wiring; no application or package installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {systemLabelFontsRequired} from './system-label-fonts.mjs';

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
const packages='sudo apt-get update -qq\n          sudo apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-cjk';
test('focused fonts preserve the four existing consumers and add only the exact System Labels path',()=>{
 const text=workflow('alpha-focused-checks.yml');
 const start=text.indexOf('      - name: Provision multilingual fonts for AI review screenshots');
 const end=text.indexOf('      - name: Classify and execute only selected files',start);
 assert(start>0&&end>start);const step=text.slice(start,end);
 const paths=[...step.matchAll(/contains\(inputs\.selected_tests, '([^']+)'\)/g)].map(match=>match[1]);
 assert.deepEqual(paths,['test/ai-management-naming.dom.test.tsx','test/ai-probe-history-page.dom.test.tsx',
  'test/feedback-kanban.dom.test.tsx','test/security-center-sidebar.dom.test.tsx',consumer]);
 assert(step.includes(packages));assert(!/continue-on-error|always\(\)/.test(step));
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
 assert(install.includes(packages));assert(!/continue-on-error|always\(\)/.test(install));
 assert.equal((text.match(/sudo apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-cjk/g)??[]).length,1);
});
test('both actual resolver control lists execute these prerequisite controls',()=>{
 for(const name of ['alpha-focused-checks.yml','alpha-staging.yml']){
  const text=workflow(name),start=text.indexOf('\n  resolve:');
  const next=text.indexOf(name==='alpha-focused-checks.yml'?'\n  selected-tests:':'\n  typecheck:',start);
  assert(start>0&&next>start);assert(text.slice(start,next).includes('.github/ci/system-label-fonts.test.mjs'));
 }
});

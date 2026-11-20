import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reconcileStaticPageCensus} from '../../scripts/performance/browser-static-census.mjs';
import {STATIC_CENSUS_SHARDS,staticPageCensusPlan} from '../../scripts/performance/system-route-manifest.mjs';

const identity={sourceSha:'a'.repeat(40),controllerSha:'b'.repeat(40)};
const person='/people/[id]', edit='/people/[id]/edit';
const manifest={'/page':'/','/payroll/page':'/payroll',[person+'/page']:person,[edit+'/page']:edit};
function dynamicVisits(path,linkDepth,parentTemplate){
 return ['first','repeat'].map(pass=>({path,sourcePath:'/',pass,role:'groupHR',outcome:'heading-visible',
  elapsedMs:385,linkDepth,parentTemplate}));
}
function fixture(){
 return Array.from({length:STATIC_CENSUS_SHARDS},(_,shard)=>{
  const plan=staticPageCensusPlan(manifest,shard);
  return {kind:'FICTIONAL_STATIC_PAGE_CENSUS',...identity,buildId:'test-build',fixtureVerified:true,
   releaseEligible:false,fixture:{tenants:2},
   staticPageCensus:{shard,shards:STATIC_CENSUS_SHARDS,...plan,
    outcomes:plan.paths.flatMap(path=>['first','repeat'].map(pass=>({path,pass,role:'groupHR',
     outcome:path==='/payroll'?'timeout':'heading-visible',elapsedMs:path==='/payroll'?15001:350}))),
    dynamic:{templates:[person,edit],missingMatchers:[],maxLinkDepth:2,discoveryFailures:0,limitedRoles:[],
     outcomes:plan.paths.includes('/')?[...dynamicVisits(person,1),...dynamicVisits(edit,2,person)]:[]},
   }};
 });
}

test('reconciles a single build while retaining failed openings and template-level evidence',()=>{
 const report=reconcileStaticPageCensus(fixture(),identity);
 assert.equal(report.compiledStaticPages,2);
 assert.equal(report.staticAttempts,4);
 assert.equal(report.staticPagesWithTwoHeadings,1);
 assert.equal(report.byOutcome.timeout,2);
 assert.equal(report.dynamicTemplatesWithHeading,2);
 const nested=report.dynamicObservations.filter(row=>row.linkDepth===2);
 assert.equal(nested.length,2);
 assert(nested.every(row=>row.parentTemplate===person));
 assert.deepEqual(report.dynamicTemplatesWithoutHeading,[]);
 assert.equal(report.releaseEligible,false);
});

test('rejects mixed source builds, incomplete visits, and duplicate shards',()=>{
 const mixed=fixture();mixed[1].buildId='other-build';
 assert.throws(()=>reconcileStaticPageCensus(mixed,identity));
 const incomplete=fixture();incomplete.find(r=>r.staticPageCensus.outcomes.length).staticPageCensus.outcomes.pop();
 assert.throws(()=>reconcileStaticPageCensus(incomplete,identity),/Missing static visit/);
 const duplicate=fixture();duplicate[1]=duplicate[0];
 assert.throws(()=>reconcileStaticPageCensus(duplicate,identity),/Duplicate census shard/);
});

test('requires both visits and an opened parent at the preceding link depth',()=>{
 const incomplete=fixture();
 incomplete.find(r=>r.staticPageCensus.paths.includes('/')).staticPageCensus.dynamic.outcomes.pop();
 assert.throws(()=>reconcileStaticPageCensus(incomplete,identity),/visit pair/);

 const unavailable=fixture();
 const owned=unavailable.find(r=>r.staticPageCensus.paths.includes('/')).staticPageCensus;
 owned.dynamic.outcomes.find(row=>row.path===person&&row.pass==='first').outcome='timeout';
 assert.throws(()=>reconcileStaticPageCensus(unavailable,identity),/visible parent detail/);

 const wrongRole=fixture();
 const root=wrongRole.find(r=>r.staticPageCensus.paths.includes('/')).staticPageCensus;
 for(const row of root.dynamic.outcomes)row.role='companyHR';
 assert.throws(()=>reconcileStaticPageCensus(wrongRole,identity),/visible static root/);
});

test('reports discovery caps and unavailable route matchers',()=>{
 const reports=fixture();
 const unmatched='/widgets/[id]';
 for(const report of reports){
  const census=report.staticPageCensus;
  census.dynamic.templates.push(unmatched);
  census.dynamic.missingMatchers=[unmatched];
  census.dynamicTemplateCount++;
 }
 const limited=reports.find(r=>r.staticPageCensus.paths.includes('/')).staticPageCensus;
 limited.dynamic.discoveryFailures=1;
 limited.dynamic.limitedRoles=['groupHR'];
 const report=reconcileStaticPageCensus(reports,identity);
 assert.deepEqual(report.dynamicTemplatesWithoutMatcher,[unmatched]);
 assert.deepEqual(report.dynamicDiscoveryLimits,[{shard:limited.shard,discoveryFailures:1,limitedRoles:['groupHR']}]);
});

test('recovers one exact source shard in disjoint parts with separate build provenance',()=>{
 const original=fixture();
 const shard=original.find(report=>report.staticPageCensus.paths.includes('/')).staticPageCensus.shard;
 const removed=original[shard];
 const recovery={shard,controllerSha:'c'.repeat(40)};
 const fragments=Array.from({length:4},(_,part)=>{
  const plan=staticPageCensusPlan(manifest,shard,part);
  return {...removed,controllerSha:recovery.controllerSha,buildId:'recovery-build',staticPageCensus:{
   ...removed.staticPageCensus,...plan,part,
   outcomes:removed.staticPageCensus.outcomes.filter(row=>plan.paths.includes(row.path)),
   dynamic:{...removed.staticPageCensus.dynamic,
    outcomes:removed.staticPageCensus.dynamic.outcomes.filter(row=>plan.paths.includes(row.sourcePath)),
   },
  }};
 });
 const reports=[...original.filter(report=>report!==removed),...fragments];
 const report=reconcileStaticPageCensus(reports,{...identity,recovery});
 assert.equal(report.kind,'FICTIONAL_COMPILED_BROWSER_CENSUS_RECOVERY');
 assert.equal(report.buildId,'test-build');
 assert.deepEqual(report.recovery,{...recovery,buildId:'recovery-build',parts:4});
 assert.equal(report.staticAttempts,4);
 assert.equal(report.dynamicTemplatesWithHeading,2);
 assert.throws(()=>reconcileStaticPageCensus([...reports.slice(0,-1),fragments[0]],{...identity,recovery}),/Duplicate recovery part/);
 assert.throws(()=>reconcileStaticPageCensus([...reports.slice(0,-1),{...fragments[3],buildId:'unrelated'}],{...identity,recovery}));
 assert.throws(()=>reconcileStaticPageCensus(reports.slice(0,-1),{...identity,recovery}),/Incomplete static census receipts/);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reconcileStaticPageCensus} from '../../scripts/performance/browser-static-census.mjs';
import {STATIC_CENSUS_SHARDS,staticPageCensusPlan} from '../../scripts/performance/system-route-manifest.mjs';

const identity={sourceSha:'a'.repeat(40),controllerSha:'b'.repeat(40)};
const manifest={'/page':'/','/payroll/page':'/payroll','/people/[id]/page':'/people/[id]'};
function fixture(){
 return Array.from({length:STATIC_CENSUS_SHARDS},(_,shard)=>{
  const plan=staticPageCensusPlan(manifest,shard);
  return {kind:'FICTIONAL_STATIC_PAGE_CENSUS',...identity,buildId:'test-build',fixtureVerified:true,
   releaseEligible:false,fixture:{tenants:2},
   staticPageCensus:{shard,shards:STATIC_CENSUS_SHARDS,...plan,
    outcomes:plan.paths.flatMap(path=>['first','repeat'].map(pass=>({path,pass,role:'groupHR',
     outcome:path==='/payroll'?'timeout':'heading-visible',elapsedMs:path==='/payroll'?15001:350}))),
    dynamic:{templates:['/people/[id]'],maxLinkDepth:2,outcomes:plan.paths.includes('/')?[{
     path:'/people/[id]',sourcePath:'/',pass:'first',role:'groupHR',outcome:'heading-visible',elapsedMs:385,linkDepth:2,
    }]:[]},
   }};
 });
}

test('reconciles a single build while retaining failed openings and template-level evidence',()=>{
 const report=reconcileStaticPageCensus(fixture(),identity);
 assert.equal(report.compiledStaticPages,2);
 assert.equal(report.staticAttempts,4);
 assert.equal(report.staticPagesWithTwoHeadings,1);
 assert.equal(report.byOutcome.timeout,2);
 assert.equal(report.dynamicTemplatesWithHeading,1);
 assert.equal(report.dynamicObservations[0].linkDepth,2);
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

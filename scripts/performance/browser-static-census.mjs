import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {STATIC_CENSUS_SHARDS,staticPageCensusPlan} from './system-route-manifest.mjs';

const roles=new Set(['public','employee','manager','companyHR','groupHR']);
const outcomes=new Set(['heading-visible','redirect','http-error','render-error','read-unavailable',
 'external-destination','timeout','browser-failure']);
const passes=['first','repeat'];

export function reconcileStaticPageCensus(reports,{sourceSha,controllerSha}){
 assert.match(sourceSha,/^[a-f0-9]{40}$/);
 assert.match(controllerSha,/^[a-f0-9]{40}$/);
 assert.equal(reports.length,STATIC_CENSUS_SHARDS,'Incomplete static census receipts');
 const first=reports[0],reference=first.staticPageCensus;
 assert(typeof first.buildId==='string'&&first.buildId.length>0,'A shared build ID is required');
 const staticPaths=new Set(),shards=new Set(),observations=[],dynamicRows=[];
 for(const report of reports){
  assert.equal(report.kind,'FICTIONAL_STATIC_PAGE_CENSUS');
  assert.equal(report.sourceSha,sourceSha);
  assert.equal(report.controllerSha,controllerSha);
  assert.equal(report.buildId,first.buildId);
  assert.equal(report.fixtureVerified,true);
  assert.equal(report.releaseEligible,false);
  assert.deepEqual(report.fixture,first.fixture);
  const census=report.staticPageCensus;
  assert.equal(census.shards,STATIC_CENSUS_SHARDS);
  assert.equal(census.staticPageCount,reference.staticPageCount);
  assert.equal(census.dynamicTemplateCount,reference.dynamicTemplateCount);
  assert.deepEqual(census.dynamic.templates,reference.dynamic.templates);
  assert(census.paths.every(path=>typeof path==='string'&&/^\/(?:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)?$/.test(path)));
  assert.equal(new Set(census.paths).size,census.paths.length,'Duplicate static route within a shard');
  const ownManifest=Object.fromEntries(census.paths.map(path=>[path==='/'
   ? '/page' : path+'/page',path]));
  if(census.paths.length)assert.deepEqual(staticPageCensusPlan(ownManifest,census.shard).paths,[...census.paths].sort());
  else assert(Number.isInteger(census.shard)&&census.shard>=0&&census.shard<STATIC_CENSUS_SHARDS);
  assert(!shards.has(census.shard),'Duplicate census shard');
  shards.add(census.shard);
  for(const path of census.paths){
   assert(!staticPaths.has(path),'Static route appeared in two shards');
   staticPaths.add(path);
  }
  const missing=new Set(census.paths.flatMap(path=>passes.map(pass=>path+' '+pass)));
  for(const row of census.outcomes){
   assert(missing.delete(row.path+' '+row.pass),'Unexpected static visit');
   assert(roles.has(row.role)&&outcomes.has(row.outcome));
   assert(Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=0);
   observations.push({path:row.path,pass:row.pass,role:row.role,outcome:row.outcome,elapsedMs:row.elapsedMs,
    ...(outcomes.has(row.outcome)&&Number.isSafeInteger(row.headingMs)&&{headingMs:row.headingMs})});
  }
  assert.equal(missing.size,0,'Missing static visit');
  const templates=new Set(census.dynamic.templates);
  const sourcePaths=new Set(census.paths);
  for(const row of census.dynamic.outcomes){
   assert(templates.has(row.path)&&sourcePaths.has(row.sourcePath)&&roles.has(row.role)&&outcomes.has(row.outcome));
   assert(passes.includes(row.pass)&&Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=0);
   if(row.linkDepth!==undefined){
    assert(Number.isInteger(row.linkDepth)&&row.linkDepth>=1&&row.linkDepth<=census.dynamic.maxLinkDepth);
   }
   dynamicRows.push({template:row.path,sourcePath:row.sourcePath,pass:row.pass,role:row.role,
    outcome:row.outcome,elapsedMs:row.elapsedMs,...(row.linkDepth!==undefined&&{linkDepth:row.linkDepth})});
  }
 }
 assert.equal(staticPaths.size,reference.staticPageCount,'Compiled static page count differs from measured routes');
 assert.equal(reference.dynamic.templates.length,reference.dynamicTemplateCount);
 const byOutcome=Object.fromEntries([...outcomes].map(outcome=>[outcome,observations.filter(row=>row.outcome===outcome).length]));
 const byPath=new Map();
 for(const row of observations)byPath.set(row.path,[...(byPath.get(row.path)??[]),row.outcome]);
 const staticPagesWithTwoHeadings=[...byPath.values()].filter(rows=>rows.every(outcome=>outcome==='heading-visible')).length;
 const dynamicObserved=new Set(dynamicRows.filter(row=>row.outcome==='heading-visible').map(row=>row.template));
 return {kind:'FICTIONAL_COMPILED_BROWSER_CENSUS',releaseEligible:false,sourceSha,controllerSha,buildId:first.buildId,
  compiledStaticPages:staticPaths.size,staticAttempts:observations.length,staticPagesWithTwoHeadings,byOutcome,
  staticObservations:observations.sort((a,b)=>a.path.localeCompare(b.path)||a.pass.localeCompare(b.pass)),
  compiledDynamicTemplates:reference.dynamicTemplateCount,dynamicTemplatesWithHeading:dynamicObserved.size,
  dynamicTemplatesWithoutHeading:reference.dynamic.templates.filter(template=>!dynamicObserved.has(template)),
  dynamicObservations:dynamicRows,
 };
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const temp=process.env.RUNNER_TEMP;
 const reports=Array.from({length:STATIC_CENSUS_SHARDS},(_,shard)=>JSON.parse(readFileSync(join(
  temp,'browser-static-shards','browser-route-baseline-shard-'+shard,'browser-route-baseline.json',
 ),'utf8')));
 const report=reconcileStaticPageCensus(reports,{sourceSha:process.env.AIHR_CI_HEAD,controllerSha:process.env.AIHR_CI_CONTROL_HEAD});
 writeFileSync(join(temp,'browser-static-census.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({compiledStaticPages:report.compiledStaticPages,staticAttempts:report.staticAttempts,
  staticPagesWithTwoHeadings:report.staticPagesWithTwoHeadings,byOutcome:report.byOutcome,
  dynamicTemplatesWithHeading:report.dynamicTemplatesWithHeading}));
}

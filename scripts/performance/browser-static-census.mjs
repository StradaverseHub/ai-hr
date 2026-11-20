import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {STATIC_CENSUS_PARTS,STATIC_CENSUS_SHARDS,staticPageCensusPlan} from './system-route-manifest.mjs';

const roles=new Set(['public','employee','manager','companyHR','groupHR']);
const outcomes=new Set(['heading-visible','redirect','http-error','render-error','read-unavailable',
 'external-destination','timeout','browser-failure']);
function discoveryKey(role,path,pass){
 return JSON.stringify([role,path,pass]);
}

const passes=['first','repeat'];

export function reconcileStaticPageCensus(reports,{sourceSha,controllerSha,recovery}){
 assert.match(sourceSha,/^[a-f0-9]{40}$/);
 assert.match(controllerSha,/^[a-f0-9]{40}$/);
 if(recovery){
  assert(Number.isInteger(recovery.shard)&&recovery.shard>=0&&recovery.shard<STATIC_CENSUS_SHARDS);
  assert.match(recovery.controllerSha,/^[a-f0-9]{40}$/);
 }
 const expected=STATIC_CENSUS_SHARDS+(recovery?STATIC_CENSUS_PARTS-1:0);
 assert.equal(reports.length,expected,'Incomplete static census receipts');
 const first=reports.find(report=>report.staticPageCensus.part===undefined);
 assert(first&&typeof first.buildId==='string'&&first.buildId.length>0,'An original build ID is required');
 const reference=first.staticPageCensus;
 const staticPaths=new Set(),shards=new Set(),parts=new Set(),observations=[],dynamicRows=[],discoveryLimits=[];
 let recoveredBuildId;
 for(const report of reports){
  assert.equal(report.kind,'FICTIONAL_STATIC_PAGE_CENSUS');
  assert.equal(report.sourceSha,sourceSha);
  const census=report.staticPageCensus;
  if(census.part===undefined){
   assert.notEqual(census.shard,recovery?.shard,'Recovered shard cannot also supply an original receipt');
   assert.equal(report.controllerSha,controllerSha);
   assert.equal(report.buildId,first.buildId);
  }else{
   assert(recovery&&census.shard===recovery.shard,'Unexpected recovery part');
   assert.equal(report.controllerSha,recovery.controllerSha);
   assert(typeof report.buildId==='string'&&report.buildId.length>0,'A recovery build ID is required');
   recoveredBuildId??=report.buildId;
   assert.equal(report.buildId,recoveredBuildId);
   assert(!parts.has(census.part),'Duplicate recovery part');
   parts.add(census.part);
  }
  assert.equal(report.fixtureVerified,true);
  assert.equal(report.releaseEligible,false);
  assert.deepEqual(report.fixture,first.fixture);
  assert.equal(census.shards,STATIC_CENSUS_SHARDS);
  assert.equal(census.staticPageCount,reference.staticPageCount);
  assert.equal(census.dynamicTemplateCount,reference.dynamicTemplateCount);
  assert.deepEqual(census.dynamic.templates,reference.dynamic.templates);
  assert.deepEqual(census.dynamic.missingMatchers,reference.dynamic.missingMatchers);
  assert.equal(census.dynamic.maxLinkDepth,reference.dynamic.maxLinkDepth);
  assert(Number.isInteger(census.dynamic.maxLinkDepth)&&census.dynamic.maxLinkDepth>=1&&census.dynamic.maxLinkDepth<=2);
  assert(Number.isInteger(census.dynamic.discoveryFailures)&&census.dynamic.discoveryFailures>=0);
  assert(census.dynamic.limitedRoles.every(role=>roles.has(role)));
  if(census.dynamic.discoveryFailures||census.dynamic.limitedRoles.length){
   discoveryLimits.push({shard:census.shard,...(census.part===undefined?{}:{part:census.part}),discoveryFailures:census.dynamic.discoveryFailures,limitedRoles:census.dynamic.limitedRoles});
  }
  assert(census.paths.every(path=>typeof path==='string'&&/^\/(?:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)?$/.test(path)));
  assert.equal(new Set(census.paths).size,census.paths.length,'Duplicate static route within a shard');
  const ownManifest=Object.fromEntries(census.paths.map(path=>[path==='/'
   ? '/page' : path+'/page',path]));
  assert(Number.isInteger(census.shard)&&census.shard>=0&&census.shard<STATIC_CENSUS_SHARDS);
  assert(census.part===undefined||(Number.isInteger(census.part)&&census.part>=0&&census.part<STATIC_CENSUS_PARTS));
  if(census.paths.length)assert.deepEqual(staticPageCensusPlan(ownManifest,census.shard,census.part).paths,[...census.paths].sort());
  if(census.part===undefined){
   assert(!shards.has(census.shard),'Duplicate census shard');
   shards.add(census.shard);
  }
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
  for(const path of census.dynamic.missingMatchers){
   assert(templates.delete(path),'Unexpected or duplicate unmatched route template');
  }
  const openedRoots=new Set(census.outcomes.filter(row=>row.pass==='first'&&row.outcome==='heading-visible')
   .map(row=>discoveryKey(row.role,row.path,'first')));
  const byVisit=new Map();
  for(const row of census.dynamic.outcomes){
   assert(templates.has(row.path)&&roles.has(row.role)&&outcomes.has(row.outcome));
   assert(passes.includes(row.pass)&&Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=0);
   assert(Number.isInteger(row.linkDepth)&&row.linkDepth>=1&&row.linkDepth<=census.dynamic.maxLinkDepth);
   assert(openedRoots.has(discoveryKey(row.role,row.sourcePath,'first')),'Dynamic discovery has no visible static root');
   const key=discoveryKey(row.role,row.path,row.pass);
   assert(!byVisit.has(key),'Duplicate dynamic visit');
   byVisit.set(key,row);
  }
  for(const row of byVisit.values()){
   const otherPass=row.pass==='first'?'repeat':'first';
   const other=byVisit.get(discoveryKey(row.role,row.path,otherPass));
   assert(other&&other.sourcePath===row.sourcePath&&other.linkDepth===row.linkDepth
    &&other.parentTemplate===row.parentTemplate,'Missing or mismatched dynamic visit pair');
   if(row.linkDepth>1){
    const parent=byVisit.get(discoveryKey(row.role,row.parentTemplate,'first'));
    assert(parent?.outcome==='heading-visible'&&parent.sourcePath===row.sourcePath
     &&parent.linkDepth===row.linkDepth-1,'Missing visible parent detail');
   }else{
    assert(row.parentTemplate===undefined,'Unexpected parent for directly linked detail');
   }
   dynamicRows.push({template:row.path,sourcePath:row.sourcePath,pass:row.pass,role:row.role,
    outcome:row.outcome,elapsedMs:row.elapsedMs,linkDepth:row.linkDepth,
    ...(row.parentTemplate&&{parentTemplate:row.parentTemplate}),
    ...(Number.isSafeInteger(row.headingMs)&&{headingMs:row.headingMs})});
  }
 }
 assert.equal(shards.size,STATIC_CENSUS_SHARDS-(recovery?1:0),'Missing original shard');
 if(recovery)assert.equal(parts.size,STATIC_CENSUS_PARTS,'Missing recovery part');
 assert.equal(staticPaths.size,reference.staticPageCount,'Compiled static page count differs from measured routes');
 assert.equal(reference.dynamic.templates.length,reference.dynamicTemplateCount);
 const byOutcome=Object.fromEntries([...outcomes].map(outcome=>[outcome,observations.filter(row=>row.outcome===outcome).length]));
 const byPath=new Map();
 for(const row of observations)byPath.set(row.path,[...(byPath.get(row.path)??[]),row.outcome]);
 const staticPagesWithTwoHeadings=[...byPath.values()].filter(rows=>rows.every(outcome=>outcome==='heading-visible')).length;
 const dynamicObserved=new Set(dynamicRows.filter(row=>row.outcome==='heading-visible').map(row=>row.template));
 return {kind:recovery?'FICTIONAL_COMPILED_BROWSER_CENSUS_RECOVERY':'FICTIONAL_COMPILED_BROWSER_CENSUS',
  releaseEligible:false,sourceSha,controllerSha,buildId:first.buildId,
  ...(recovery&&{recovery:{...recovery,buildId:recoveredBuildId,parts:STATIC_CENSUS_PARTS}}),
  compiledStaticPages:staticPaths.size,staticAttempts:observations.length,staticPagesWithTwoHeadings,byOutcome,
  staticObservations:observations.sort((a,b)=>a.path.localeCompare(b.path)||a.pass.localeCompare(b.pass)),
  compiledDynamicTemplates:reference.dynamicTemplateCount,dynamicTemplatesWithHeading:dynamicObserved.size,
  dynamicTemplatesWithoutHeading:reference.dynamic.templates.filter(template=>!dynamicObserved.has(template)),
  dynamicObservations:dynamicRows,dynamicDiscoveryLimits:discoveryLimits,
  dynamicTemplatesWithoutMatcher:reference.dynamic.missingMatchers,
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

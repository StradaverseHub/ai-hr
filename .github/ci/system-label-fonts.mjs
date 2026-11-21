/** Select an external font prerequisite from the exact complete unit; never a test or release PASS. */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';

const consumer='test/system-label-exchange-browser.test.ts';
export function systemLabelFontsRequired(plan,id,{candidate,controller}){
 assert(/^[0-9a-f]{40}$/.test(candidate??'')&&/^[0-9a-f]{40}$/.test(controller??''),'Exact candidate and controller required');
 assert(plan&&plan.sha===candidate&&plan.controller===controller,'Font prerequisite source identity differs');
 assert(Array.isArray(plan.units)&&Array.isArray(plan.suite),'Complete current source plan required');
 assert(typeof id==='string'&&id.length>0,'Exact unit required');
 const matches=plan.units.filter(unit=>unit?.id===id);
 assert(matches.length===1,'Unknown or duplicate font prerequisite unit');
 const unit=matches[0];
 assert(['db','nodb'].includes(unit.kind),'Font setup requires a non-browser test unit');
 assert(Array.isArray(unit.files)&&unit.files.length>0&&unit.files.every(file=>typeof file==='string'&&plan.suite.includes(file))
  &&new Set(unit.files).size===unit.files.length,'Complete distinct source unit files required');
 return unit.files.includes(consumer);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_REPOSITORY_ID==='1333414856','Disposable repository runner only');
 assert(process.argv.length===3,'One exact test unit argument required');
 const output=process.env.GITHUB_OUTPUT;assert(typeof output==='string'&&isAbsolute(output),'Runner output path required');
 const required=systemLabelFontsRequired(createPlan(),process.argv[2],{candidate:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD});
 appendFileSync(output,`required=${required}\n`);
}

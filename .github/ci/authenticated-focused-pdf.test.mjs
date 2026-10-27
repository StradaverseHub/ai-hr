import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authenticateFocusedPdfTools} from './authenticated-focused-pdf.mjs';
import {FOCUSED_TOOLING_CONTROLLER} from './reviewed-focused-controller.mjs';
const file='test/payslip-pdf.test.ts';
function fixture(){return {files:[file],plan:{controller:FOCUSED_TOOLING_CONTROLLER,units:[{id:'pdf',pdfTools:true,files:[file]}]},
 run:{id:1,head_sha:FOCUSED_TOOLING_CONTROLLER,head_branch:'codex/letters-repair-tooling-20261027'},
 job:{started_at:'2026-10-27T00:00:00Z',completed_at:'2026-10-27T00:10:00Z',steps:[]},artifacts:[],now:Date.parse('2026-10-27T00:11:00Z')};}
test('ordinary selections require no PDF tooling archive',async()=>{
 assert.equal(await authenticateFocusedPdfTools({files:['test/other.test.ts'],artifacts:[]}),null);
 await assert.rejects(authenticateFocusedPdfTools({files:['test/other.test.ts'],artifacts:[{name:'focused-pdf-tool-evidence'}]}),/Unexpected/);
});
test('PDF selection refuses unreviewed controller, absent archive and foreign scope before transport',async()=>{
 const a=fixture();a.plan.controller='0'.repeat(40);await assert.rejects(authenticateFocusedPdfTools(a),/Unreviewed/);
 await assert.rejects(authenticateFocusedPdfTools(fixture()),/Exactly one/);
 const b=fixture();b.files.push('test/foreign.test.ts');await assert.rejects(authenticateFocusedPdfTools(b),/source-audited/);
});
test('PDF evidence refuses foreign origin, expired bounds and missing native setup before transport',async()=>{
 const origin={id:1,repository_id:1333414856,head_repository_id:1333414856,head_sha:FOCUSED_TOOLING_CONTROLLER,head_branch:'codex/letters-repair-tooling-20261027'};
 for(const change of [a=>a.workflow_run.id=2,a=>a.workflow_run.repository_id=0,a=>a.expired=true,a=>a.size_in_bytes=1048577,a=>a.created_at='2026-10-26T00:00:00Z',a=>a.expires_at='2026-10-27T00:00:00Z',()=>{}]){
  const f=fixture(),a={name:'focused-pdf-tool-evidence',workflow_run:{...origin},expired:false,size_in_bytes:100,created_at:'2026-10-27T00:05:00Z',expires_at:'2026-10-28T00:00:00Z'};change(a);f.artifacts=[a];
  await assert.rejects(authenticateFocusedPdfTools(f));
 }
});

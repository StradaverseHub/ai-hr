/** Additional source-bound native tooling evidence; never application or release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {validatePdfSetupProof} from './pdf-tools.mjs';
import {FOCUSED_TOOLING_CONTROLLER} from './reviewed-focused-controller.mjs';
import {installHash} from './ci-install-grant.mjs';
const consumers=['test/payslip-pdf.test.ts','test/r379-pcb2ii-pdf.test.ts'];
export async function authenticateFocusedPdfTools({files,plan,run,job,artifacts,directory,now=Date.now()}){
 const matches=artifacts.filter(a=>a.name==='focused-pdf-tool-evidence');
 if(!files.some(f=>consumers.includes(f))){assert(matches.length===0,'Unexpected focused PDF evidence');return null;}
 assert(plan.controller===FOCUSED_TOOLING_CONTROLLER,'Unreviewed focused PDF setup controller');
 const units=plan.units.filter(u=>u.pdfTools===true);
 assert(units.length===1&&files.every(f=>units[0].files.includes(f)),'Only source-audited PDF selection may use this setup');
 assert(matches.length===1,'Exactly one native PDF tooling archive required');
 const artifact=matches[0],origin=artifact.workflow_run;
 assert(origin?.id===run.id&&origin.repository_id===1333414856&&origin.head_repository_id===1333414856
  &&origin.head_sha===run.head_sha&&origin.head_branch===run.head_branch,'Foreign PDF tooling archive');
 assert(artifact.expired===false&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=1024*1024
  &&Date.parse(artifact.created_at)>=Date.parse(job.started_at)&&Date.parse(artifact.created_at)<=Date.parse(job.completed_at)
  &&Date.parse(artifact.expires_at)>now,'Invalid PDF tooling archive time or size');
 const steps=job.steps.filter(s=>s.name==='Prepare source-bound tools for the selected PDF suite');
 assert(steps.length===1&&steps[0].status==='completed'&&steps[0].conclusion==='success','Native PDF setup did not succeed');
 const dir=join(directory,'pdf-tooling');mkdirSync(dir,{mode:0o700});
 const transport=await downloadCiArchives([artifact],dir);
 const path=join(dir,artifact.name+'.zip');readCiArchive(artifact,path);
 const script=`import json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 rows=z.infolist()
 assert len(rows)==1
 row=rows[0]
 assert row.filename=='pdf-tools-setup.json' and 0<row.file_size<=1048576 and not row.flag_bits&1
 assert not stat.S_ISLNK(row.external_attr>>16)
 data=z.read(row)
 assert len(data)==row.file_size
 print(json.dumps(json.loads(data)))
`;
 const proof=JSON.parse(execFileSync('python3',['-c',script,path],{encoding:'utf8',timeout:10000,maxBuffer:2*1024**2}));
 validatePdfSetupProof(plan,units[0],proof);
 const required=['ready pdfinfo','ready pdftotext','ready pdftoppm','ready python venv capability','create private PDF venv','install required PyMuPDF','native PDF roundtrip'];
 assert(Array.isArray(proof.steps)&&proof.steps.length<=20,'Bounded actual PDF command evidence required');
 for(const label of required){const rows=proof.steps.filter(s=>s.label===label);assert(rows.length===1&&rows[0].status===0&&!rows[0].errorCode&&!rows[0].signal,'Missing or unsuccessful native PDF step: '+label);}
 return {kind:'AUTHENTICATED_FOCUSED_NATIVE_PDF_TOOLING_NOT_RELEASE',releaseAuthorized:false,
  unit:units[0].id,files,artifactId:artifact.id,digest:artifact.digest,proofSha256:installHash(JSON.stringify(proof)),proof,transport};
}

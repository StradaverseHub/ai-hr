/** Explicit fictional-browser setup only. The ordinary migration entry and production guards stay unchanged. */
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {platform} from 'node:os';
import {inspectResignationBrowserRoleAdmission,RESIGNATION_BROWSER_ROLE_MODE} from './lib/resignation-browser-role-admission';
async function main(){
 if(process.argv.length!==2)throw Error('No alternate browser migration arguments.');
 const admission=inspectResignationBrowserRoleAdmission(process.env,{platform:platform(),cwd:process.cwd(),realpath:path=>realpathSync(path),read:path=>readFileSync(path,'utf8'),git:(cwd,args)=>execFileSync('git',[...args],{cwd,encoding:'utf8'})});
 // The reviewed fixture owner is imported only after all host, source, event, URL and evidence checks.
 const owner=await import('../test/helpers/personnel-draft-discard-ci-role-fixture');owner.assertDisposableDraftDiscardFixture(admission.admin,undefined,admission.binding);
 const fixture=await owner.prepareDisposableDraftDiscardRoles(admission.admin,undefined,admission.binding);if(fixture.mode!==RESIGNATION_BROWSER_ROLE_MODE)throw Error('Fictional browser prerequisite result changed.');
 writeFileSync(join(admission.binding.evidenceDirectory,'personnel-draft-discard-browser-role-prerequisites.json'),JSON.stringify({kind:'SYNTHETIC_BROWSER_ROLE_PREREQUISITES',releaseEligible:false,phase:'before_initial_candidate_migration',...admission.binding,scope:'job-owned fresh fictional renderer cluster only; no installation or native attestation',fixture},null,2)+'\n',{flag:'wx',mode:0o600});
 const child=spawnSync('pnpm',['db:migrate'],{stdio:'inherit',env:process.env});if(child.error||child.signal||child.status===null)throw Error('Existing migration entry did not finish naturally.');process.exitCode=child.status;
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Fictional browser migration refused.');process.exitCode=1;});

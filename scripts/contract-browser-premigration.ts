/** Exact hosted fictional Contract prerequisite admission; ordinary migration guards stay intact. */
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {platform} from 'node:os';
import {inspectContractBrowserRoleAdmission,CONTRACT_BROWSER_ROLE_MODE} from './lib/contract-browser-role-admission';
async function main(){
 if(process.argv.length!==2)throw Error('No alternate Contract migration arguments.');
 const admission=inspectContractBrowserRoleAdmission(process.env,{platform:platform(),cwd:process.cwd(),realpath:path=>realpathSync(path),read:path=>readFileSync(path,'utf8'),git:(cwd,args)=>execFileSync('git',[...args],{cwd,encoding:'utf8'})});
 const owner=await import('../test/helpers/personnel-draft-discard-ci-role-fixture');
 owner.assertDisposableDraftDiscardFixture(admission.admin,undefined,undefined,admission.binding);
 const fixture=await owner.prepareDisposableDraftDiscardRoles(admission.admin,undefined,undefined,admission.binding);
 if(fixture.mode!==CONTRACT_BROWSER_ROLE_MODE)throw Error('Contract prerequisite receipt changed.');
 writeFileSync(join(admission.binding.evidenceDirectory,'contract-browser-role-prerequisites.json'),JSON.stringify({kind:'SYNTHETIC_CONTRACT_BROWSER_ROLE_PREREQUISITES',releaseEligible:false,phase:'before_initial_candidate_migration',...admission.binding,scope:'job-owned fresh fictional cluster only; no installation or business grants',fixture},null,2)+'\n',{flag:'wx',mode:0o600});
 const child=spawnSync('pnpm',['db:migrate'],{stdio:'inherit',env:process.env});
 if(child.error||child.signal||child.status===null)throw Error('Ordinary migration did not finish naturally.');
 process.exitCode=child.status;
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Contract migration refused.');process.exitCode=1;});

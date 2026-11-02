/** Minimal static sources exercising the actual canonical generators; no application execution. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AI_MANIFEST_INPUTS} from './ai-manifest-admission.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const fixtureGit=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function writeFixture(root,name,bytes){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);}
export function initAiManifestFixture(cwd){
 const provider=readFileSync(join(root,'scripts/ai-provider-data-source-manifest.mjs'),'utf8');
 const roots=JSON.parse(/^const roots=(\[.*\]);$/m.exec(provider)[1].replaceAll("'",'"'));
 for(const name of roots)writeFixture(cwd,name,'// Static synthetic source\n');
 for(const name of AI_MANIFEST_INPUTS)writeFixture(cwd,name,readFileSync(join(root,name)));
 writeFixture(cwd,'lib/ai/provider-data-approvals.ts','export const fixtureApproval = {sourceDigest: "'+'a'.repeat(64)+'"};\n');
 fixtureGit(cwd,'init','--quiet');
 fixtureGit(cwd,'config','user.name','Synthetic CI Fixture');fixtureGit(cwd,'config','user.email','fixture@example.invalid');
 regenerateAiManifests(cwd);return commitAiManifestFixture(cwd);
}
export function regenerateAiManifests(cwd){
 for(const script of ['scripts/ai-provider-data-source-manifest.mjs','scripts/ai-agent-source-manifest.mjs'])execFileSync(process.execPath,[script],{cwd,stdio:'pipe'});
}
export function commitAiManifestFixture(cwd){
 fixtureGit(cwd,'add','.');fixtureGit(cwd,'-c','core.hooksPath=/dev/null','commit','--quiet','--no-gpg-sign','-m','Synthetic static fixture');return fixtureGit(cwd,'rev-parse','HEAD');
}

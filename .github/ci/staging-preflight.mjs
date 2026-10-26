/** Read-only early deployment-profile check. It never installs, migrates, restarts or changes config. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {cleanHead} from './release-ci.mjs';
import {STAGING_BUILD_RUNTIME} from './build-production.mjs';
import {stagingTransport} from './staging-transport.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const DEPLOY_RUNTIME_SELECTION='  [ -x /opt/node22/bin/node ] || { echo "CI build installation requires its pinned Node22 runtime" >&2; exit 1; }\n  export PATH="/opt/node22/bin:$PATH"';
export function validateCandidateRuntimeSelection(source){
 const branch='\nif [ -n "$AIHR_SELECTED_CI_BUILD_INSTALL" ]; then\n'+DEPLOY_RUNTIME_SELECTION+'\nelif [ -d /opt/node24/bin ];';
 assert(source.split(branch).length===2,'Candidate CI runtime selection differs; review preflight protocol');
}


export function stagingProfileProbeCommand(checker){
 assert(typeof checker==='function','Actual candidate customer checker required');
 const source=checker.toString();assert(source.length>1000&&source.length<32000&&!source.includes('AIHR_PROFILE_PREFLIGHT_NODE')&&!source.includes('AIHR_PROFILE_PREFLIGHT_SHELL'),'Bounded complete customer checker required');
 const script="import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';import path from 'node:path';\n"+
  'const customerEnvironmentErrors='+source+';\n'+
  "const profile=process.env.ALLOW_DEMO_SESSION==='true'?'demo':'customer';\n"+
  "const errors=profile==='customer'?customerEnvironmentErrors():[];\n"+
  "const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(readFileSync('node_modules/next/package.json','utf8')).version};\n"+
  'console.log(JSON.stringify({kind:"STAGING_PROFILE_PREFLIGHT_ONLY",checkerSha256:'+JSON.stringify(hash(source))+',profile,runtime,errors,ok:errors.length===0,releaseAuthorized:false}));\n';
 // Match deploy.sh's CI-specific runtime branch, default profile predicate and shell-sourced environment. Do not substitute a
 // developer env, Node --env-file precedence, or merely the current service's login result.
 return "bash -s <<'AIHR_PROFILE_PREFLIGHT_SHELL'\nset -eu\ncd /opt/ai-hr\ntest -f .env.production\n"+DEPLOY_RUNTIME_SELECTION+"\nset -a\n. ./.env.production\nset +a\nnode --input-type=module <<'AIHR_PROFILE_PREFLIGHT_NODE'\n"+script+'AIHR_PROFILE_PREFLIGHT_NODE\nAIHR_PROFILE_PREFLIGHT_SHELL';
}
export function validateStagingProfile(report,checker){
 assert(report&&Object.keys(report).sort().join(',')==='checkerSha256,errors,kind,ok,profile,releaseAuthorized,runtime','Unexpected profile report');
 assert(report.kind==='STAGING_PROFILE_PREFLIGHT_ONLY'&&report.releaseAuthorized===false&&report.checkerSha256===hash(checker.toString()),'Customer checker binding differs');
 assert(['demo','customer'].includes(report.profile)&&Array.isArray(report.errors)&&report.errors.length<=64&&report.errors.every(e=>typeof e==='string'&&e.length>0&&e.length<=1000),'Invalid profile result');
 assert(typeof report.ok==='boolean'&&report.ok===(report.errors.length===0),'Inconsistent customer preflight result');
 if(!report.ok){const error=new Error('Staging deployment profile refused before CI archive download/source transfer: '+report.errors.join('; '));error.preflight=report;throw error;}
 assert(isDeepStrictEqual(report.runtime,STAGING_BUILD_RUNTIME),'Actual deploy toolchain differs from pinned CI native build');
 return report;
}
export async function probeStagingProfile({candidatePath,ssh}){
 candidatePath=resolve(candidatePath);const candidate=cleanHead(candidatePath),file=join(candidatePath,'deploy/check-customer-env.mjs'),sourceSha256=hash(readFileSync(file));
 const deploySource=readFileSync(join(candidatePath,'deploy/deploy.sh'),'utf8');validateCandidateRuntimeSelection(deploySource);
 const checkerUrl=pathToFileURL(file);checkerUrl.searchParams.set('source',sourceSha256);
 const {customerEnvironmentErrors}=await import(checkerUrl.href);
 const output=ssh(stagingProfileProbeCommand(customerEnvironmentErrors),{timeout:30000,maxBuffer:64*1024});
 assert(typeof output==='string'&&Buffer.byteLength(output)<=64*1024,'Bounded profile response required');
 const result=validateStagingProfile(JSON.parse(output),customerEnvironmentErrors);
 assert(cleanHead(candidatePath)===candidate&&hash(readFileSync(file))===sourceSha256,'Candidate checker changed during preflight');
 return {...result,candidate,checkerFileSha256:sourceSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [candidatePath]=process.argv.slice(2);assert(candidatePath&&process.argv.length===3,'Usage: node staging-preflight.mjs <clean-candidate>');
 const transport=stagingTransport(resolve(candidatePath));
 const ssh=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024,...options});
 probeStagingProfile({candidatePath,ssh}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}

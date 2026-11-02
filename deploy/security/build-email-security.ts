/** Produces an isolated source-bound protected service artifact; never installs, reads private config or sends mail. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export async function buildEmailSecurity(destination:string){
 if(process.versions.node!=='22.23.3'||process.platform!=='linux'||process.arch!=='x64')throw Error('Canonical Linux Node22.23.3 builder required');
 const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(!/^[a-f0-9]{40}$/.test(source))throw Error('Exact source required');
 const version=JSON.parse(await readFile(require.resolve('nodemailer/package.json'),'utf8')).version;
 if(version!=='10.1.4')throw Error('Reviewed Nodemailer10.1.4 required');
 const result=await build({entryPoints:['deploy/identity-email/agent.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',write:false,metafile:true,logLevel:'silent',define:{IDENTITY_EMAIL_RETAIN_LETTERS_HOLD:'true'}});
 if(result.outputFiles.length!==1||!result.metafile)throw Error('Single bundled agent and input inventory required');
 const bytes=result.outputFiles[0].contents,inputs=Object.keys(result.metafile.inputs).sort();
 if(!inputs.some(p=>p.includes('nodemailer'))||inputs.some(p=>/nodemailer@10\.1\.0(?:\/|$)/.test(p)))throw Error('SMTP dependency inventory differs');
 const inputHashes=await Promise.all(inputs.map(async path=>({path,sha256:hash(await readFile(path))})));
 const nodeSha256=hash(await readFile(process.execPath));
 let maintenance=await readFile('deploy/security/maintenance.py','utf8');
 for(const [key,value] of Object.entries({SOURCE_SHA:source,AGENT_SHA256:hash(bytes),AGENT_BASE64:Buffer.from(bytes).toString('base64'),NODE_SHA256:nodeSha256})){
  const marker=key+" = ''";if(maintenance.split(marker).length!==2)throw Error('Exact root template marker required');maintenance=maintenance.replace(marker,key+' = '+JSON.stringify(value));
 }
 const maintenanceBytes=Buffer.from(maintenance),ingressPolicySha256=hash(await readFile('deploy/security/ingress-policy.mjs'));
 const manifest={kind:'PROTECTED_EMAIL_SECURITY_ARTIFACT_NOT_INSTALLED',schemaVersion:1,source,controller:process.env.AIHR_CI_CONTROL_HEAD??null,runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,agent:{file:'agent.cjs',sha256:hash(bytes),bytes:bytes.length,nodemailer:version,retainsLettersHold:true},runtime:{node:process.versions.node,modules:process.versions.modules,platform:process.platform,arch:process.arch,nodeSha256:hash(await readFile(process.execPath))},lockSha256:hash(await readFile('pnpm-lock.yaml')),maintenance:{file:'maintenance.py',sha256:hash(maintenanceBytes),bytes:maintenanceBytes.length,ingressPolicySha256},inputHashes,installerExecuted:false,privateConfigurationRead:false,mailSent:false,releaseAuthorized:false};
 const output=resolve(destination);await mkdir(output,{recursive:true,mode:0o700});await writeFile(join(output,'agent.cjs'),bytes,{flag:'wx',mode:0o600});await writeFile(join(output,'maintenance.py'),maintenanceBytes,{flag:'wx',mode:0o600});await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const destination=process.argv[2];if(!destination)throw Error('Private output directory required');buildEmailSecurity(destination).then(m=>console.log(JSON.stringify({source:m.source,sha256:m.agent.sha256,nodemailer:m.agent.nodemailer,installed:false}))).catch(()=>{console.error('Protected email artifact build refused; no installation performed.');process.exitCode=1;});
}

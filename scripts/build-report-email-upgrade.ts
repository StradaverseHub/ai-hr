/** Build only under the coordinated resource handoff. Root installs hash-reviewed self-contained artifacts. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
function requiredOutput(result:{outputFiles?:{contents:Uint8Array}[]},entry:string):Uint8Array {
 const output=result.outputFiles?.[0];
 if(!output)throw new Error(`Expected a bundled output for ${entry}.`);
 return output.contents;
}
async function main(){
 const common={bundle:true,platform:'node' as const,target:'node20',format:'cjs' as const,write:false,logLevel:'silent' as const};
 const agent=requiredOutput(await build({...common,entryPoints:['deploy/identity-email/agent.ts']}),'agent');
 const renderer=requiredOutput(await build({...common,entryPoints:['deploy/identity-email/report-renderer.ts']}),'renderer');
 const probe=await readFile('deploy/identity-email/verify-report-isolation.py'),peer=await readFile('deploy/identity-email/renderer-peer.py'),unit=await readFile('deploy/identity-email/aihr-report-renderer@.service'),socket=await readFile('deploy/identity-email/aihr-report-renderer.socket'),slice=await readFile('deploy/identity-email/aihrmanagedmail.slice');
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const upgrade=requiredOutput(await build({...common,entryPoints:['deploy/identity-email/upgrade-reports.ts'],define:{REPORT_EMAIL_AGENT_BASE64:JSON.stringify(Buffer.from(agent).toString('base64')),REPORT_EMAIL_AGENT_SHA256:JSON.stringify(hash(agent)),REPORT_RENDERER_BASE64:JSON.stringify(Buffer.from(renderer).toString('base64')),REPORT_RENDERER_SHA256:JSON.stringify(hash(renderer)),REPORT_RENDERER_PEER_BASE64:JSON.stringify(peer.toString('base64')),REPORT_RENDERER_PEER_SHA256:JSON.stringify(hash(peer)),REPORT_RENDERER_PROBE_BASE64:JSON.stringify(probe.toString('base64')),REPORT_RENDERER_PROBE_SHA256:JSON.stringify(hash(probe)),REPORT_RENDERER_UNIT_BASE64:JSON.stringify(unit.toString('base64')),REPORT_RENDERER_SOCKET_BASE64:JSON.stringify(socket.toString('base64')),REPORT_MAIL_SLICE_BASE64:JSON.stringify(slice.toString('base64'))}}),'upgrade');
 await mkdir('deploy/identity-email/generated',{recursive:true});await writeFile('deploy/identity-email/generated/report-upgrade.cjs',upgrade);
 console.log('Service bundle sha256: '+hash(agent));console.log('Renderer bundle sha256: '+hash(renderer));console.log('Root upgrade sha256: '+hash(upgrade));
}
main().catch(()=>{console.error('Report email upgrade build failed.');process.exitCode=1;});

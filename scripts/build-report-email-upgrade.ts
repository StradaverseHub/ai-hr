/** Build only under the coordinated resource handoff. Root installs hash-reviewed self-contained artifacts. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
async function main(){
 const common={bundle:true,platform:'node' as const,target:'node20',format:'cjs' as const,write:false,logLevel:'silent' as const};
 const agent=(await build({...common,entryPoints:['deploy/identity-email/agent.ts']})).outputFiles[0].contents;
 const renderer=(await build({...common,entryPoints:['deploy/identity-email/report-renderer.ts']})).outputFiles[0].contents;
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const upgrade=(await build({...common,entryPoints:['deploy/identity-email/upgrade-reports.ts'],define:{REPORT_EMAIL_AGENT_BASE64:JSON.stringify(Buffer.from(agent).toString('base64')),REPORT_EMAIL_AGENT_SHA256:JSON.stringify(hash(agent)),REPORT_RENDERER_BASE64:JSON.stringify(Buffer.from(renderer).toString('base64')),REPORT_RENDERER_SHA256:JSON.stringify(hash(renderer))}})).outputFiles[0].contents;
 await mkdir('deploy/identity-email/generated',{recursive:true});await writeFile('deploy/identity-email/generated/report-upgrade.cjs',upgrade);
 console.log('Service bundle sha256: '+hash(agent));console.log('Renderer bundle sha256: '+hash(renderer));console.log('Root upgrade sha256: '+hash(upgrade));
}
main().catch(()=>{console.error('Report email upgrade build failed.');process.exitCode=1;});

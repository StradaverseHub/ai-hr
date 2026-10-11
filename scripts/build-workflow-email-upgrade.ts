/** Produces a single reviewed artifact. The root operator must copy it into root-only staging and verify its printed digest. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { writeFile,mkdir } from 'node:fs/promises';
async function main(){
 const agent=await build({entryPoints:['deploy/identity-email/agent.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',write:false,logLevel:'silent'});
 const bytes=agent.outputFiles[0].contents,hash=createHash('sha256').update(bytes).digest('hex');
 const upgrade=await build({entryPoints:['deploy/identity-email/upgrade-workflow.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',write:false,logLevel:'silent',define:{WORKFLOW_EMAIL_AGENT_BASE64:JSON.stringify(Buffer.from(bytes).toString('base64')),WORKFLOW_EMAIL_AGENT_SHA256:JSON.stringify(hash)}});
 await mkdir('deploy/identity-email/generated',{recursive:true});
 const output=upgrade.outputFiles[0].contents;await writeFile('deploy/identity-email/generated/workflow-upgrade.cjs',output);
 console.log('Service bundle sha256: '+hash);console.log('Root upgrade sha256: '+createHash('sha256').update(output).digest('hex'));
}
main().catch(()=>{console.error('Workflow email upgrade build failed.');process.exitCode=1;});

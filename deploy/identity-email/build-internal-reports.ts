/** Source-only until coordinated build. No installer runs here; output needs operator hash review. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {INTERNAL_REPORT_DISPATCH_SOURCE_FILES} from '../../lib/employee-master-dispatch';
async function main(){
 const common={bundle:true,platform:'node' as const,target:'node22',format:'cjs' as const,write:false,logLevel:'silent' as const};
 const files:Record<string,{base64:string;sha256:string;mode:number}>={};
 const add=(name:string,bytes:Uint8Array,mode=0o644)=>{files[name]={base64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),mode};};
 for(const [name,entry]of [['internal-report-agent.cjs','internal-report-agent.ts'],['report-auth-broker.cjs','report-auth-broker.ts'],['report-renderer.cjs','report-renderer.ts']]){
  const result=await build({...common,entryPoints:['deploy/identity-email/'+entry]});const bytes=result.outputFiles?.[0]?.contents;if(!bytes)throw new Error('Missing reviewed bundle.');add(name,bytes);
 }
 const pins=Object.fromEntries(await Promise.all(INTERNAL_REPORT_DISPATCH_SOURCE_FILES.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
 const scheduling=await build({...common,entryPoints:['deploy/identity-email/schedule-internal-reports.ts'],define:{INTERNAL_REPORT_DISPATCH_SOURCE_PINS:JSON.stringify(pins)}});if(!scheduling.outputFiles?.[0])throw new Error('Missing scheduling bundle.');add('internal-report-schedule.cjs',scheduling.outputFiles[0].contents);
 add('internal-report-tick',await readFile('deploy/identity-email/internal-report-tick'),0o755);
 for(const name of ['report-auth-peer.py','renderer-peer.py','verify-internal-report-isolation.py','aihr-report-auth.socket','aihr-report-auth@.service','aihr-internal-report.socket','aihr-internal-report.service','aihrmanagedmail.slice','aihrmanagedmail-dispatch.slice'])add(name,await readFile('deploy/identity-email/'+name));
 const rendererUnit=(await readFile('deploy/identity-email/aihr-report-renderer@.service','utf8')).replace('InaccessiblePaths=/var/lib/aihr-identity-email /etc/aihr-keycloak /opt/ai-hr','InaccessiblePaths=-/var/lib/aihr-identity-email -/etc/aihr-keycloak -/opt/ai-hr');add('aihr-report-renderer@.service',Buffer.from(rendererUnit));
 // Internal selection changes only this installed copy; external0600/mail-only default stays intact.
 const rendererSocket=(await readFile('deploy/identity-email/aihr-report-renderer.socket','utf8')).replace('SocketMode=0600','SocketGroup=aihr-report-clients\nSocketMode=0660');add('aihr-report-renderer.socket',Buffer.from(rendererSocket));
 const output=await build({...common,entryPoints:['deploy/identity-email/upgrade-internal-reports.ts'],define:{INTERNAL_REPORT_FILES:JSON.stringify(files)}});
 const bytes=output.outputFiles?.[0]?.contents;if(!bytes)throw new Error('Missing installer bundle.');
 await mkdir('deploy/identity-email/generated',{recursive:true});await writeFile('deploy/identity-email/generated/internal-report-upgrade.cjs',bytes);
 console.log('Internal report installer SHA256: '+createHash('sha256').update(bytes).digest('hex'));
 for(const [name,record]of Object.entries(files))console.log(name+' SHA256: '+record.sha256);
}
main().catch(()=>{console.error('Internal report bundle build refused.');process.exitCode=1;});

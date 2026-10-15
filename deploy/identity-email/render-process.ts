/** Trusted private process adapter. The web endpoint never supplies paths, credentials, scopes or bytes. */
import {spawn} from 'node:child_process';
import {lstat,readFile,unlink} from 'node:fs/promises';
import {z} from 'zod';
import {masterRendererRequest} from './render-context';
import {reportRenderDatabase} from './render-config';
import {MasterDeliveryPreparationError,type MasterDeliveryTarget,type MasterPreparedAttachment} from './reports';
import {MASTER_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/employee-master-delivery-model';
const runtime='/usr/local/lib/aihr-identity-email',directory='/var/lib/aihr-identity-email/render';
const file=(id:string,token:string)=>directory+'/'+z.uuid().parse(id)+'-'+z.uuid().parse(token)+'.xlsx';
const response=z.discriminatedUnion('ok',[z.object({ok:z.literal(false),reason:z.enum(['notEligible','generationFailed','attachmentTooLarge'])}).strict(),z.object({ok:z.literal(true),accessStamp:z.string().regex(/^[a-f0-9]{64}$/),filename:z.string().max(150).optional(),contentType:z.string().max(100).optional(),rowCount:z.number().int().min(0).max(50000).optional(),scopeIds:z.array(z.uuid()).max(100).optional()}).strict()]);
export async function reportRendererReady(){
 try{reportRenderDatabase(process.env.REPORT_RENDER_DATABASE_URL??'',process.env.IDENTITY_EMAIL_DATABASE_URL);const [bundle,dir]=await Promise.all([lstat(runtime+'/report-renderer.cjs'),lstat(directory)]);return bundle.isFile()&&bundle.uid===0&&(bundle.mode&0o022)===0&&dir.isDirectory()&&(dir.mode&0o077)===0;}catch{return false;}
}
async function child(phase:'render'|'authorize',id:string,token:string,target:MasterDeliveryTarget){
 const request=masterRendererRequest.parse({phase,occurrenceId:id,leaseToken:token,expectedAccessStamp:target.accessStamp});
 if(!await reportRendererReady())throw new MasterDeliveryPreparationError('generationFailed');
 return new Promise<z.infer<typeof response>>((resolve,reject)=>{
  const processChild=spawn(process.execPath,['--max-old-space-size=384',runtime+'/report-renderer.cjs'],{cwd:runtime,env:{DATABASE_URL:process.env.REPORT_RENDER_DATABASE_URL!,WORKFLOW_EMAIL_ISSUER:process.env.WORKFLOW_EMAIL_ISSUER!,REPORT_RENDER_OUTPUT_PATH:file(id,token),NODE_ENV:'production',TZ:'UTC'},stdio:['pipe','pipe','ignore']});
  const chunks:Buffer[]=[];let size=0,settled=false;const finish=(error?:unknown,value?:z.infer<typeof response>)=>{if(settled)return;settled=true;clearTimeout(watchdog);error?reject(error):resolve(value!);};
  const watchdog=setTimeout(()=>{processChild.kill('SIGKILL');finish(new MasterDeliveryPreparationError('generationFailed'));},phase==='render'?65_000:20_000);
  processChild.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096){processChild.kill('SIGKILL');finish(new MasterDeliveryPreparationError('generationFailed'));}else chunks.push(chunk);});
  processChild.on('error',()=>finish(new MasterDeliveryPreparationError('generationFailed')));
  processChild.stdin.on('error',()=>finish(new MasterDeliveryPreparationError('generationFailed')));
  processChild.on('close',()=>{try{const value=response.parse(JSON.parse(Buffer.concat(chunks).toString()));finish(undefined,value);}catch{finish(new MasterDeliveryPreparationError('generationFailed'));}});
  processChild.stdin.end(JSON.stringify(request));
 });
}
export async function prepareMasterReportFile(id:string,token:string,target:MasterDeliveryTarget):Promise<MasterPreparedAttachment>{
 const result=await child('render',id,token,target);if(!result.ok)throw new MasterDeliveryPreparationError(result.reason);
 const path=file(id,token),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MASTER_EMAIL_ATTACHMENT_MAX_BYTES||(stat.mode&0o077)!==0)throw new MasterDeliveryPreparationError(stat.size>MASTER_EMAIL_ATTACHMENT_MAX_BYTES?'attachmentTooLarge':'generationFailed');
 const bytes=await readFile(path);if(bytes.byteLength!==stat.size||!result.filename||!result.contentType||result.rowCount==null||!result.scopeIds||result.accessStamp!==target.accessStamp)throw new MasterDeliveryPreparationError('generationFailed');
 return {bytes,filename:result.filename,contentType:result.contentType,rowCount:result.rowCount,scopeIds:result.scopeIds};
}
export async function authorizeMasterReportFile(id:string,token:string,target:MasterDeliveryTarget){const result=await child('authorize',id,token,target);return result.ok&&result.accessStamp===target.accessStamp;}
export async function removeMasterReportFile(id:string,token:string){try{await unlink(file(id,token));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
/** Startup cleanup covers a killed renderer/service. Paths are always derived from two UUIDs. */
export async function cleanupMasterReportFiles(){
 const {readdir}=await import('node:fs/promises');
 try{for(const name of await readdir(directory)){if(!/^[0-9a-f-]{36}-[0-9a-f-]{36}\.xlsx$/i.test(name))continue;const path=directory+'/'+name,stat=await lstat(path);if(stat.isFile()&&Date.now()-stat.mtimeMs>600_000)await unlink(path);}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

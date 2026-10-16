/** Private Unix socket adapter. The renderer runs under a separate UID and proves kernel peer credentials. */
import {Socket} from 'node:net';
import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {z} from 'zod';
import {masterRendererRequest} from './render-context';
import {MasterDeliveryPreparationError,type MasterDeliveryTarget,type MasterPreparedAttachment} from './reports';
import {readPreparedReportBytes} from './report-bytes';
import {masterArtifactFingerprint,masterArtifactAuthorization,type MasterArtifactAuthorization} from '../../lib/employee-master-artifact-model';
const socketPath='/run/aihr-report-renderer.sock',directory='/var/lib/aihr-report-renderer/render';
const file=(id:string,token:string)=>directory+'/'+z.uuid().parse(id)+'-'+z.uuid().parse(token)+'.xlsx';
const response=z.discriminatedUnion('ok',[z.object({ok:z.literal(false),reason:z.enum(['notEligible','generationFailed','attachmentTooLarge'])}).strict(),z.object({ok:z.literal(true),accessStamp:z.string().regex(/^[a-f0-9]{64}$/).optional(),filename:z.string().max(150).optional(),contentType:z.string().max(100).optional(),rowCount:z.number().int().min(0).max(50000).optional(),scopeCount:z.number().int().min(1).max(100).optional(),ready:z.boolean().optional(),removed:z.boolean().optional(),artifact:masterArtifactFingerprint.optional()}).strict()]);
async function renderer(input:z.infer<typeof masterRendererRequest>){
 const body=masterRendererRequest.parse(input);
 return new Promise<z.infer<typeof response>>((resolve,reject)=>{
  const socket=new Socket({allowHalfOpen:true}),chunks:Buffer[]=[];let size=0,settled=false;
  const finish=(error?:unknown,value?:z.infer<typeof response>)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value!);};
  socket.setTimeout(body.phase==='render'?85_000:25_000,()=>finish(new MasterDeliveryPreparationError('generationFailed')));
  socket.on('error',()=>finish(new MasterDeliveryPreparationError('generationFailed')));
  socket.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096)finish(new MasterDeliveryPreparationError('generationFailed'));else chunks.push(chunk);});
  socket.on('end',()=>{try{finish(undefined,response.parse(JSON.parse(Buffer.concat(chunks).toString())));}catch{finish(new MasterDeliveryPreparationError('generationFailed'));}});
  socket.connect(socketPath,()=>socket.end(JSON.stringify(body)));
 });
}
export async function reportRendererReady(){
 try{const [socket,dir]=await Promise.all([lstat(socketPath),lstat(directory)]);if(!socket.isSocket()||socket.uid!==process.getuid?.()||(process.env.AUTH_PROVIDER==='internal'?(socket.mode&0o777)!==0o660:(socket.mode&0o077)!==0)||!dir.isDirectory()||dir.uid!==Number(process.env.REPORT_RENDERER_UID)||(dir.mode&0o027)!==0)return false;const result=await renderer({phase:'status'});return result.ok&&result.ready===true;}catch{return false;}
}
export async function prepareMasterReportFile(id:string,token:string,target:MasterDeliveryTarget):Promise<MasterPreparedAttachment>{
 const result=await renderer({phase:'render',occurrenceId:id,leaseToken:token,expectedAccessStamp:target.accessStamp});if(!result.ok)throw new MasterDeliveryPreparationError(result.reason);
 const handle=await open(file(id,token),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
 try{bytes=await readPreparedReportBytes(handle,Number(process.env.REPORT_RENDERER_UID));if(!result.filename||!result.contentType||result.rowCount==null||result.scopeCount!==target.companyIds.length||result.accessStamp!==target.accessStamp)throw new MasterDeliveryPreparationError('generationFailed');
 }finally{await handle.close();}
 if(!result.filename||!result.contentType||result.rowCount==null)throw new MasterDeliveryPreparationError('generationFailed');
 return {bytes,filename:result.filename,contentType:result.contentType,rowCount:result.rowCount,scopeIds:target.companyIds};
}
export async function authorizeMasterReportFile(id:string,token:string,target:MasterDeliveryTarget){const result=await renderer({phase:'authorize',occurrenceId:id,leaseToken:token,expectedAccessStamp:target.accessStamp});return result.ok&&result.accessStamp===target.accessStamp;}
/** The private caller obtains authority directly from the renderer; no forwarded manifest is accepted.
 * Unlike the compatibility boolean above, this API requires a complete authoritative fingerprint. */
export async function authorizeReportArtifact(input:{occurrenceId:string;leaseToken:string;expectedAccessStamp:string}):Promise<MasterArtifactAuthorization>{
 const result=await renderer({phase:'authorize',occurrenceId:input.occurrenceId,leaseToken:input.leaseToken,expectedAccessStamp:input.expectedAccessStamp});
 if(!result.ok)throw new MasterDeliveryPreparationError(result.reason);
 const parsed=masterArtifactAuthorization.safeParse(result);
 if(!parsed.success||parsed.data.accessStamp!==input.expectedAccessStamp)throw new MasterDeliveryPreparationError('generationFailed');
 return {accessStamp:parsed.data.accessStamp,artifact:parsed.data.artifact};
}
export async function removeMasterReportFile(id:string,token:string){const result=await renderer({phase:'remove',occurrenceId:id,leaseToken:token});if(!result.ok||!result.removed)throw new Error('Private artifact cleanup unavailable.');}

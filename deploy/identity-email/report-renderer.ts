/** Separately installed child. It receives no SMTP/provider/migration credential and writes no HR fact. */
import {writeFile,readdir,lstat,unlink,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {sql} from 'drizzle-orm';
import {reportRenderDatabase,reportRenderOrigin} from './render-config';
import {masterRenderContext,masterRendererRequest,type MasterRenderContext} from './render-context';
import type {SessionContext} from '../../db/client';
import {MASTER_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/employee-master-delivery-model';
import {fingerprintOwnedReportArtifact} from './report-artifact';
import type {MasterArtifactFingerprint} from '../../lib/employee-master-artifact-model';
import {rendererPeerRole,rendererPeerMayRequest} from './renderer-peer-policy';
const directory='/var/lib/aihr-report-renderer/render';
const file=(id:string,token:string)=>directory+'/'+id+'-'+token+'.xlsx';
async function cleanExpired(){const names=(await readdir(directory)).filter(name=>/^[0-9a-f-]{36}-[0-9a-f-]{36}\.xlsx$/i.test(name));for(const name of names){const stat=await lstat(directory+'/'+name);if(stat.isFile()&&Date.now()-stat.mtimeMs>600_000)await unlink(directory+'/'+name);}return (await readdir(directory)).filter(name=>name.endsWith('.xlsx')).length;}
async function main(){
 const peerRole=rendererPeerRole({selfUid:process.getuid?.()??-1,rendererUid:Number(process.env.REPORT_RENDERER_UID),mailUid:Number(process.env.REPORT_RENDERER_MAIL_UID),peerUid:Number(process.env.REPORT_RENDERER_PEER_UID),brokerUid:process.env.REPORT_RENDERER_AUTH_BROKER_UID===undefined?undefined:Number(process.env.REPORT_RENDERER_AUTH_BROKER_UID)});
 if(!peerRole)throw new Error('Private renderer activation refused.');
 reportRenderDatabase(process.env.DATABASE_URL??'');
 const internalOrigin=process.env.AUTH_PROVIDER==='internal'?reportRenderOrigin(process.env.AUTH_PUBLIC_ORIGIN??''):null;
 if(process.env.MIGRATION_DATABASE_URL||process.env.IDENTITY_EMAIL_DATABASE_URL||process.env.IDENTITY_EMAIL_CLIENT_SECRET||process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET||process.env.AUTH_SESSION_KEY)throw new Error('Private renderer environment is not isolated.');
 let size=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>4096)throw new Error('Invalid renderer request.');chunks.push(chunk);}
 const request=masterRendererRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
 if(!rendererPeerMayRequest(peerRole,request.phase))throw new Error('Private renderer operation refused.');
 // The broker's authorize-only path never performs expiry deletion or other artifact mutation.
 const existing=peerRole==='mail'?await cleanExpired():0;
 if(request.phase==='remove'){try{await unlink(file(request.occurrenceId,request.leaseToken));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}process.stdout.write(JSON.stringify({ok:true,removed:true})+'\n');return;}
 if(request.phase==='render'&&existing>=20)throw new Error('Private artifact budget reached.');
 // Dynamic imports run only after the explicit app-role environment has been validated.
 const {db,client,withTenant}=await import('../../db/client');
 try{
  const [role]=await db.execute(sql`select current_user as name,r.rolsuper,r.rolbypassrls,(r.rolcreaterole or r.rolcreatedb or r.rolreplication or exists(select 1 from pg_auth_members m where m.member=r.oid) or exists(select 1 from pg_class c where c.relowner=r.oid) or exists(select 1 from pg_namespace n where n.nspowner=r.oid)) as privileged from pg_roles r where r.rolname=current_user`) as unknown as {name:string;rolsuper:boolean;rolbypassrls:boolean;privileged:boolean}[];
  if(role?.name!=='ai_hr_app'||role.rolsuper||role.rolbypassrls||role.privileged)throw new Error('Renderer role refused.');
  if(request.phase==='status'){process.stdout.write(JSON.stringify({ok:true,ready:true})+'\n');return;}
  const resolve=async()=>{
   const [row]=await db.execute(process.env.AUTH_PROVIDER==='internal'
    ?sql`select app.employee_master_internal_render_context(${request.occurrenceId}::uuid,${request.leaseToken}::uuid,${internalOrigin}) as context`
    :sql`select app.employee_master_render_context(${request.occurrenceId}::uuid,${request.leaseToken}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER??''}) as context`) as unknown as {context:unknown}[];
   const parsed=masterRenderContext.safeParse(row?.context);if(!parsed.success||parsed.data.accessStamp!==request.expectedAccessStamp)throw Object.assign(new Error('Report is no longer eligible.'),{notEligible:true});return parsed.data;
  };
  const {resolveEntitlementsTx}=await import('../../core/entitlements'),{allowedCompanies}=await import('../../core/read'),{getEmployeeMasterReport}=await import('../../core/employee-master-reports');
  const context=async(value:MasterRenderContext,owner:boolean)=>{
   const grants=owner?value.ownerGrants:value.recipientGrants,base:SessionContext={tenantId:value.tenantId,userId:owner?value.ownerUserId:value.recipientUserId,personId:owner?value.ownerPersonId:value.recipientPersonId,grants,roles:[...new Set(grants.map(grant=>grant.role))]};
   const ctx={...base,entitlements:await withTenant(base,tx=>resolveEntitlementsTx(tx,base.tenantId),{readOnlySnapshot:true})};
   return {ctx,scopeIds:(await allowedCompanies(ctx)).map(company=>company.id)};
  };
  const check=async()=>{
   const value=await resolve(),owner=await context(value,true),recipient=await context(value,false);
   const [ownerReport,recipientReport]=await Promise.all([getEmployeeMasterReport(owner.ctx,owner.scopeIds,value.reportId),getEmployeeMasterReport(recipient.ctx,recipient.scopeIds,value.reportId)]);
   if(ownerReport.ownerUserId!==value.ownerUserId||ownerReport.version!==value.reportVersion||recipientReport.version!==value.reportVersion||JSON.stringify([...ownerReport.spec.companyIds].sort())!==JSON.stringify([...value.companyIds].sort()))throw Object.assign(new Error('Report access changed.'),{notEligible:true});
   return {value,recipient};
  };
  const {value,recipient}=await check();
  if(request.phase==='authorize'){
   const handle=await open(file(request.occurrenceId,request.leaseToken),constants.O_RDONLY|constants.O_NOFOLLOW);
   let artifact:MasterArtifactFingerprint;try{artifact=await fingerprintOwnedReportArtifact(handle,Number(process.env.REPORT_RENDERER_UID));}finally{await handle.close();}
   await resolve();process.stdout.write(JSON.stringify({ok:true,accessStamp:value.accessStamp,artifact})+'\n');return;
  }
  const {renderEmployeeMasterDelivery}=await import('../../core/employee-master-schedules');
  const rendered=await renderEmployeeMasterDelivery(recipient.ctx,{reportId:value.reportId,expectedVersion:value.reportVersion,scopeIds:recipient.scopeIds,recipientEmploymentId:value.recipientEmploymentId,consentRevision:value,scheduleId:value.scheduleId,scheduleRevision:value.scheduleRevision,reviewedDigest:value.reviewedDigest,locale:value.locale});
  if(rendered.bytes.byteLength>MASTER_EMAIL_ATTACHMENT_MAX_BYTES)throw Object.assign(new Error('Attachment too large.'),{tooLarge:true});
  await check();
  const path=file(request.occurrenceId,request.leaseToken);
  await writeFile(path,rendered.bytes,{flag:'wx',mode:0o640});
  process.stdout.write(JSON.stringify({ok:true,filename:rendered.filename,contentType:rendered.contentType,rowCount:rendered.rowCount,scopeCount:rendered.scopeIds.length,accessStamp:value.accessStamp})+'\n');
 }finally{await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{process.stdout.write(JSON.stringify({ok:false,reason:(error?.notEligible||error?.name==='MasterReportAccessError'||['forbidden','notAvailable'].includes(error?.code))?'notEligible':error?.tooLarge?'attachmentTooLarge':'generationFailed'})+'\n');process.exit(1);});

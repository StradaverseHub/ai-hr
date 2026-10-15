/** Separately installed child. It receives no SMTP/provider/migration credential and writes no HR fact. */
import {writeFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import {reportRenderDatabase} from './render-config';
import {masterRenderContext,masterRendererRequest,type MasterRenderContext} from './render-context';
import type {SessionContext} from '../../db/client';
import {MASTER_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/employee-master-delivery-model';
async function main(){
 reportRenderDatabase(process.env.DATABASE_URL??'');
 if(process.env.MIGRATION_DATABASE_URL||process.env.IDENTITY_EMAIL_DATABASE_URL||process.env.IDENTITY_EMAIL_CLIENT_SECRET||process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET)throw new Error('Private renderer environment is not isolated.');
 let size=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>4096)throw new Error('Invalid renderer request.');chunks.push(chunk);}
 const request=masterRendererRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
 // Dynamic imports run only after the explicit app-role environment has been validated.
 const {db,client,withTenant}=await import('../../db/client');
 try{
  const [role]=await db.execute(sql`select current_user as name,r.rolsuper,r.rolbypassrls,(r.rolcreaterole or r.rolcreatedb or r.rolreplication or exists(select 1 from pg_auth_members m where m.member=r.oid) or exists(select 1 from pg_class c where c.relowner=r.oid) or exists(select 1 from pg_namespace n where n.nspowner=r.oid)) as privileged from pg_roles r where r.rolname=current_user`) as unknown as {name:string;rolsuper:boolean;rolbypassrls:boolean;privileged:boolean}[];
  if(role?.name!=='ai_hr_app'||role.rolsuper||role.rolbypassrls||role.privileged)throw new Error('Renderer role refused.');
  const resolve=async()=>{
   const [row]=await db.execute(sql`select app.employee_master_render_context(${request.occurrenceId}::uuid,${request.leaseToken}::uuid,${process.env.WORKFLOW_EMAIL_ISSUER??''}) as context`) as unknown as {context:unknown}[];
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
  if(request.phase==='authorize'){await resolve();process.stdout.write(JSON.stringify({ok:true,accessStamp:value.accessStamp})+'\n');return;}
  const {renderEmployeeMasterDelivery}=await import('../../core/employee-master-schedules');
  const rendered=await renderEmployeeMasterDelivery(recipient.ctx,{reportId:value.reportId,expectedVersion:value.reportVersion,scopeIds:recipient.scopeIds,recipientEmploymentId:value.recipientEmploymentId,consentRevision:value,scheduleId:value.scheduleId,scheduleRevision:value.scheduleRevision,reviewedDigest:value.reviewedDigest});
  if(rendered.bytes.byteLength>MASTER_EMAIL_ATTACHMENT_MAX_BYTES)throw Object.assign(new Error('Attachment too large.'),{tooLarge:true});
  await check();
  const path=process.env.REPORT_RENDER_OUTPUT_PATH,expected='/var/lib/aihr-identity-email/render/'+request.occurrenceId+'-'+request.leaseToken+'.xlsx';
  if(path!==expected)throw new Error('Invalid private render path.');
  await writeFile(path,rendered.bytes,{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({ok:true,filename:rendered.filename,contentType:rendered.contentType,rowCount:rendered.rowCount,scopeIds:rendered.scopeIds,accessStamp:value.accessStamp})+'\n');
 }finally{await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{process.stdout.write(JSON.stringify({ok:false,reason:(error?.notEligible||error?.name==='MasterReportAccessError'||['forbidden','notAvailable'].includes(error?.code))?'notEligible':error?.tooLarge?'attachmentTooLarge':'generationFailed'})+'\n');process.exit(1);});

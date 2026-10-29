import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {defaultEmailDocument} from '../lib/email-design/model';
import {buildXlsx} from '../lib/spreadsheet';
import {fingerprintReportBytes} from '../lib/employee-master-artifact';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from '../lib/email-attachment';
import {createInternalMasterReportDeliveryService,type InternalReportDependencies} from '../deploy/identity-email/internal-reports';
import type {ReportBrokerResponse,ReportBrokerTarget} from '../lib/internal-auth/report-broker-model';
import type {MasterPreparedAttachment} from '../deploy/identity-email/reports';
async function fixture(){
 const target:ReportBrokerTarget={tenantId:randomUUID(),ownerUserId:randomUUID(),recipientUserId:randomUUID(),recipientEmploymentId:randomUUID(),reportId:randomUUID(),reportVersion:2,scheduleId:randomUUID(),scheduleRevision:randomUUID(),reviewedDigest:'a'.repeat(64),subject:randomUUID(),email:'recipient@report-acceptance.invalid',locale:'en',consentAfterSequence:12,policyAfterSequence:4,consentUpdatedAt:'2026-01-01T00:00:00.000001Z',policyUpdatedAt:'2026-01-01T00:00:00.000002Z',consentVerifiedAt:'2026-01-01T00:00:00.000003Z',ownerGrants:[],recipientGrants:[],ownerPersonId:null,recipientPersonId:null,accessStamp:'b'.repeat(64),companyIds:[randomUUID()]};
 const attachment:MasterPreparedAttachment={bytes:Buffer.from(await buildXlsx(['Employee ID','Name'],[['0012','Fictional employee']],{sheetName:'Employee Master',textColumns:[0],textRowFloor:1})),filename:'Employee-Master.xlsx',contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,rowCount:1,scopeIds:target.companyIds};
 const relay={config:{host:'smtp.report-acceptance.invalid',port:465,security:'tls' as const,from:'owner@report-acceptance.invalid',fromName:'Fictional report',replyTo:'',auth:true,user:'fixture'},password:'fictional-relay-only'};
 const deps:InternalReportDependencies={origin:'https://report-acceptance.invalid',rendererReady:vi.fn(async()=>true),
  broker:vi.fn(async(request):Promise<ReportBrokerResponse>=>request.phase==='status'?{available:true}:request.phase==='inspect'?{ok:true,phase:'inspect',target,inspectionProof:'opaque_inspection_proof'}:{ok:true,phase:'start',target,artifact:fingerprintReportBytes(attachment.bytes,attachment.contentType),relay}),
  prepare:vi.fn(async()=>attachment),finish:vi.fn(async()=>true),send:vi.fn(async()=>{})};
 return {target,attachment,relay,deps,run:createInternalMasterReportDeliveryService(deps),input:{op:'sendReport' as const,occurrenceId:randomUUID(),leaseToken:randomUUID()}};
}
describe('internal report transport, no provider/key/store ownership',()=>{
 it('sends the actual workbook once only after complete canonical start and exact artifact binding',async()=>{
  const f=await fixture();expect(await f.run(f.input)).toEqual({outcome:'sent'});
  expect(f.deps.broker).toHaveBeenNthCalledWith(1,{phase:'inspect',occurrenceId:f.input.occurrenceId,leaseToken:f.input.leaseToken});
  expect(f.deps.broker).toHaveBeenNthCalledWith(2,{phase:'start',occurrenceId:f.input.occurrenceId,leaseToken:f.input.leaseToken,inspectionProof:'opaque_inspection_proof',expectedArtifact:fingerprintReportBytes(f.attachment.bytes,f.attachment.contentType)});
  expect(f.deps.send).toHaveBeenCalledWith(f.relay,f.target,f.attachment,`<employee-master-${f.input.occurrenceId}@report-acceptance.invalid>`,undefined);
  expect(Array.from(f.attachment.bytes.slice(0,2))).toEqual([80,75]);
  expect(f.deps.finish).toHaveBeenCalledWith(f.input.occurrenceId,f.input.leaseToken,'sent',null,{rowCount:1,scopeIds:f.target.companyIds});
 });
 it('forwards only the validated design returned by canonical start with the same exact recipient and workbook',async()=>{
  const f=await fixture(),design={kind:'employee_master_report' as const,locale:'en' as const,document:{...defaultEmailDocument('employee_master_report'),subject:'Fictional reviewed report'},data:{company_name:'Fictional company'}};
  vi.mocked(f.deps.broker).mockResolvedValueOnce({ok:true,phase:'inspect',target:f.target,inspectionProof:'opaque_inspection_proof'}).mockResolvedValueOnce({ok:true,phase:'start',target:f.target,artifact:fingerprintReportBytes(f.attachment.bytes,f.attachment.contentType),relay:f.relay,design});
  expect(await f.run(f.input)).toEqual({outcome:'sent'});expect(f.deps.send).toHaveBeenCalledTimes(1);
  expect(f.deps.send).toHaveBeenCalledWith(f.relay,f.target,f.attachment,`<employee-master-${f.input.occurrenceId}@report-acceptance.invalid>`,design);
 });
 it('uses readiness without nonce or relay disclosure and still requires renderer readiness',async()=>{
  const f=await fixture();expect(await f.run({op:'status'})).toEqual({version:1,ready:true});expect(f.deps.broker).toHaveBeenCalledWith({phase:'status'});expect(f.deps.prepare).not.toHaveBeenCalled();
  vi.mocked(f.deps.rendererReady).mockResolvedValue(false);expect(await f.run({op:'status'})).toEqual({version:1,ready:false});
  vi.mocked(f.deps.broker).mockResolvedValue({available:false});expect(await f.run({op:'status'})).toEqual({version:1,ready:false});
 });
 it.each(['notEligible','generationFailed','attachmentTooLarge','busy','unavailable'] as const)('does not send on a finite inspect refusal: %s',async reason=>{
  const f=await fixture();vi.mocked(f.deps.broker).mockResolvedValue({ok:false,reason});await f.run(f.input);expect(f.deps.prepare).not.toHaveBeenCalled();expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.deps.finish).toHaveBeenCalledTimes(['notEligible','generationFailed','attachmentTooLarge'].includes(reason)?1:0);
 });
 it('cannot accept caller address, bytes, credential, origin or scope flags',async()=>{
  const f=await fixture();for(const extra of [{email:'other@report-acceptance.invalid'},{bytes:'file'},{relay:f.relay},{origin:'https://other.invalid'},{admin:true}])await expect(f.run({...f.input,...extra})).rejects.toThrow();expect(f.deps.broker).not.toHaveBeenCalled();
 });
 it.each(['busy','unavailable'] as const)('does not finish or send an explicit start %s',async reason=>{
  const f=await fixture();vi.mocked(f.deps.broker).mockResolvedValueOnce({ok:true,phase:'inspect',target:f.target,inspectionProof:'proof'}).mockResolvedValueOnce({ok:false,reason});expect(await f.run(f.input)).toEqual({outcome:reason});expect(f.deps.finish).not.toHaveBeenCalled();expect(f.deps.send).not.toHaveBeenCalled();
 });
 it('treats lost/malformed start reply as UNKNOWN, never an unstarted retry or SMTP attempt',async()=>{
  for(const broken of [new Error('EOF lost'),{ok:true,phase:'start'}]){const f=await fixture();vi.mocked(f.deps.broker).mockResolvedValueOnce({ok:true,phase:'inspect',target:f.target,inspectionProof:'proof'});if(broken instanceof Error)vi.mocked(f.deps.broker).mockRejectedValueOnce(broken);else vi.mocked(f.deps.broker).mockResolvedValueOnce(broken as ReportBrokerResponse);expect(await f.run(f.input)).toEqual({outcome:'unknown'});expect(f.deps.send).not.toHaveBeenCalled();expect(f.deps.finish).not.toHaveBeenCalled();}
 });
 it('records definite generationFailed before SMTP when authoritative digest disagrees',async()=>{
  const f=await fixture();vi.mocked(f.deps.broker).mockResolvedValueOnce({ok:true,phase:'inspect',target:f.target,inspectionProof:'proof'}).mockResolvedValueOnce({ok:true,phase:'start',target:f.target,relay:f.relay,artifact:{...fingerprintReportBytes(f.attachment.bytes,f.attachment.contentType),sha256:'f'.repeat(64)}});
  expect(await f.run(f.input)).toEqual({outcome:'failed'});expect(f.deps.send).not.toHaveBeenCalled();expect(f.deps.finish).toHaveBeenCalledWith(f.input.occurrenceId,f.input.leaseToken,'failed','generationFailed',expect.any(Object));
 });
 it('detects Buffer mutation during start and keeps it outside SMTP uncertainty classification',async()=>{
  const f=await fixture();vi.mocked(f.deps.broker).mockImplementation(async request=>{if(request.phase==='inspect')return {ok:true,phase:'inspect',target:f.target,inspectionProof:'proof'};if(request.phase==='start'){const artifact=fingerprintReportBytes(f.attachment.bytes,f.attachment.contentType);f.attachment.bytes[0]^=1;return {ok:true,phase:'start',target:f.target,artifact,relay:f.relay};}return {available:true};});
  expect(await f.run(f.input)).toEqual({outcome:'failed'});expect(f.deps.send).not.toHaveBeenCalled();expect(f.deps.finish).toHaveBeenCalledWith(f.input.occurrenceId,f.input.leaseToken,'failed','generationFailed',expect.any(Object));
 });
 it('refuses foreign scope and oversized workbook before start',async()=>{
  for(const value of ['foreign','oversize']){const f=await fixture();if(value==='foreign')f.attachment.scopeIds=[randomUUID()];else f.attachment.bytes=new Uint8Array(XLSX_EMAIL_ATTACHMENT_MAX_BYTES+1);expect(await f.run(f.input)).toEqual({outcome:'failed'});expect(f.deps.broker).toHaveBeenCalledTimes(1);expect(f.deps.send).not.toHaveBeenCalled();}
 });
 it('holds ambiguous SMTP ACK as uncertain and never retries an attempt',async()=>{
  const f=await fixture();vi.mocked(f.deps.send).mockRejectedValue(new Error('ACK lost'));expect(await f.run(f.input)).toEqual({outcome:'uncertain'});expect(f.deps.send).toHaveBeenCalledTimes(1);expect(f.deps.finish).toHaveBeenCalledWith(f.input.occurrenceId,f.input.leaseToken,'uncertain','uncertain',expect.any(Object));
 });
 it('does not rewrite successful SMTP when finish acknowledgement is lost',async()=>{
  const f=await fixture();vi.mocked(f.deps.finish).mockResolvedValue(false);await expect(f.run(f.input)).rejects.toThrow('acknowledgement');expect(f.deps.send).toHaveBeenCalledTimes(1);expect(f.deps.finish).toHaveBeenCalledTimes(1);
 });
});

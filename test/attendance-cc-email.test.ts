import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createNotificationEmailService,type WorkflowEmailDependencies,type WorkflowMail} from '../deploy/identity-email/notifications';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
import {notificationEmailRequest} from '../lib/notification-email-model';
import type {AttendanceCcTarget} from '../lib/attendance-cc-mail';
let d:WorkflowEmailDependencies,target:AttendanceCcTarget;
const job={op:'attendanceCcSend' as const,deliveryId:randomUUID(),leaseToken:randomUUID()};
beforeEach(()=>{
 target={kind:'employee',userId:randomUUID(),subject:'fictional-subject',email:'fictional@example.invalid',locale:'en',message:{reference:randomUUID(),applicant:'Fictional applicant <b>',level:2,action:'approved',actor:'Fictional deciding approver',occurredAt:new Date().toISOString()}};
 d={origin:'https://fictional.example.invalid',ready:vi.fn(async()=>true),target:vi.fn(),verifyRecipient:vi.fn(async()=>'verified' as const),start:vi.fn(),finish:vi.fn(),send:vi.fn(async()=>{}),cc:{target:vi.fn(async()=>target),start:vi.fn(async()=>true),finish:vi.fn(async()=>true)}};
});
describe('CC uses the existing private mail owner with an occurrence capability',()=>{
 it('accepts only an ID/token command and never caller recipients, content, attachments or approval tokens',()=>{
  expect(notificationEmailRequest.safeParse(job).success).toBe(true);
  for(const extra of [{to:'victim@example.invalid'},{message:'caller message'},{attachments:[]},{approvalToken:'token'}])expect(notificationEmailRequest.safeParse({...job,...extra}).success).toBe(false);
 });
 it('checks the live internal identity and current lease before captured delivery',async()=>{
  expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'sent'});
  expect(d.verifyRecipient).toHaveBeenCalledOnce();expect(d.cc!.start).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,target);
  expect(d.send).toHaveBeenCalledOnce();expect(d.cc!.finish).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,'sent',null);
  expect(d.target).not.toHaveBeenCalled();expect(d.start).not.toHaveBeenCalled();
 });
 it('does not send after identity revocation or a lost/changed lease',async()=>{
  vi.mocked(d.verifyRecipient).mockResolvedValue('changed');expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'skipped'});expect(d.cc!.start).not.toHaveBeenCalled();expect(d.send).not.toHaveBeenCalled();
  vi.mocked(d.verifyRecipient).mockResolvedValue('verified');vi.mocked(d.cc!.start).mockResolvedValue(false);expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'busy'});expect(d.send).not.toHaveBeenCalled();
 });
 it('uses only the database-resolved external target and refuses extra sensitive fields or email headers',async()=>{
  target={...target,kind:'custom_email',userId:null,subject:null};
  expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'sent'});expect(d.verifyRecipient).not.toHaveBeenCalled();
  vi.mocked(d.send).mockClear();vi.mocked(d.cc!.target).mockResolvedValue({...target,message:{...target.message,reason:'private reason',salary:'10000'}});
  expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'skipped'});expect(d.send).not.toHaveBeenCalled();
  vi.mocked(d.cc!.target).mockResolvedValue({...target,email:'x@example.invalid\r\nBcc:victim@example.invalid'});expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'skipped'});expect(d.send).not.toHaveBeenCalled();
 });
 it('respects relay/provider unavailability before starting SMTP',async()=>{
  vi.mocked(d.ready).mockResolvedValue(false);expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'unavailable'});expect(d.cc!.target).not.toHaveBeenCalled();expect(d.send).not.toHaveBeenCalled();
  vi.mocked(d.ready).mockResolvedValue(true);vi.mocked(d.verifyRecipient).mockResolvedValue('unavailable');expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'unavailable'});expect(d.cc!.start).not.toHaveBeenCalled();
 });
 it.each([[{responseCode:451},'retry','smtpTemporary'],[{responseCode:550},'failed','smtpRejected'],[{code:'ECONNRESET'},'uncertain','uncertain']] as const)('records SMTP result %s without treating an unknown acknowledgement as a safe resend',async(error,outcome,reason)=>{
  vi.mocked(d.send).mockRejectedValue(error);expect(await createNotificationEmailService(d)(job)).toEqual({outcome});expect(d.cc!.finish).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,outcome,reason);
 });
 it('does not manufacture success when SMTP finished but the durable result could not be recorded',async()=>{
  vi.mocked(d.cc!.finish).mockResolvedValue(false);await expect(createNotificationEmailService(d)(job)).rejects.toThrow('result could not be recorded');expect(d.send).toHaveBeenCalledOnce();
 });
 it.each(['en','ms','zh','vi','ta','th'] as const)('renders only the six permitted decision details in %s, escaping HTML and preserving the normal access gate',locale=>{
  const mail:WorkflowMail={category:'attendance',locale,link:`https://fictional.example.invalid/attendance/application-history/${target.message.reference}`,action:false,messageId:'<fictional@example.invalid>',attendanceCc:target.message};
  const rendered=workflowEmailMessage(mail);expect(rendered.text).toContain(target.message.reference);expect(rendered.text).toContain(target.message.applicant);expect(rendered.text).toContain(target.message.actor);expect(rendered.html).toContain('&lt;b&gt;');expect(rendered.html).not.toContain('applicant <b>');expect(rendered).not.toHaveProperty('attachments');expect(rendered.text).not.toMatch(/approvalToken|salary|private reason/);
 });
});

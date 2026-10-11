import { beforeEach,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { activeWorkflowRelay,createNotificationEmailService,type WorkflowEmailDependencies,type WorkflowMailTarget } from '../deploy/identity-email/notifications';
import { defaultEmailConfig } from '../lib/identity/email-model';
let d:WorkflowEmailDependencies,target:WorkflowMailTarget;const job={op:'send',deliveryId:randomUUID(),leaseToken:randomUUID()};
beforeEach(()=>{
 target={user_id:randomUUID(),subject:randomUUID(),email:'employee@example.test',category:'leave',link_path:'/me',severity:'info',locale:'ms'};
 d={origin:'https://hr.test',ready:vi.fn().mockResolvedValue(true),target:vi.fn().mockResolvedValue(target),verifyRecipient:vi.fn().mockResolvedValue('verified'),start:vi.fn().mockResolvedValue(true),finish:vi.fn().mockResolvedValue(true),send:vi.fn().mockResolvedValue(undefined)};
});
describe('isolated workflow email orchestration',()=>{
 it('does not send or mark started until relay, target, verified account and durable lease all permit it',async()=>{
  expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'sent'});
  expect(d.start).toHaveBeenCalledWith(job.deliveryId,job.leaseToken);
  expect(d.send).toHaveBeenCalledWith(target,expect.objectContaining({category:'leave',locale:'ms',link:'https://hr.test/me',action:false,messageId:`<notification-${job.deliveryId}@hr.test>`}));
  expect(d.finish).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,'sent',null);
 });
 it('holds a job before SMTP if the relay or identity provider is unavailable',async()=>{
  vi.mocked(d.ready).mockResolvedValue(false);await createNotificationEmailService(d)(job);expect(d.target).not.toHaveBeenCalled();
  vi.mocked(d.ready).mockResolvedValue(true);vi.mocked(d.verifyRecipient).mockResolvedValue('unavailable');await createNotificationEmailService(d)(job);
  expect(d.send).not.toHaveBeenCalled();expect(d.start).not.toHaveBeenCalled();expect(d.finish).not.toHaveBeenCalled();
 });
 it('skips a changed recipient without adopting a matching address elsewhere',async()=>{
  vi.mocked(d.verifyRecipient).mockResolvedValue('changed');expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'skipped'});
  expect(d.start).not.toHaveBeenCalled();expect(d.send).not.toHaveBeenCalled();expect(d.finish).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,'skipped','recipientChanged');
 });
 it('rejects an external event link before starting SMTP',async()=>{
  target.link_path='//attacker.test';await createNotificationEmailService(d)(job);expect(d.start).not.toHaveBeenCalled();expect(d.send).not.toHaveBeenCalled();
 });
 it('losing the atomic start race cannot cause a second send',async()=>{
  vi.mocked(d.start).mockResolvedValue(false);expect(await createNotificationEmailService(d)(job)).toEqual({outcome:'busy'});expect(d.send).not.toHaveBeenCalled();expect(d.finish).not.toHaveBeenCalled();
 });
 it('records an explicit SMTP rejection separately from a lost acknowledgement',async()=>{
  vi.mocked(d.send).mockRejectedValue({responseCode:451});await createNotificationEmailService(d)(job);expect(d.finish).toHaveBeenLastCalledWith(job.deliveryId,job.leaseToken,'retry','smtpTemporary');
  vi.mocked(d.send).mockRejectedValue(new Error('secret relay details'));await createNotificationEmailService(d)(job);expect(d.finish).toHaveBeenLastCalledWith(job.deliveryId,job.leaseToken,'uncertain','uncertain');
 });
 it('never converts SMTP acceptance followed by a lost DB commit into a retry',async()=>{
  vi.mocked(d.finish).mockRejectedValue(new Error('DB unavailable'));await expect(createNotificationEmailService(d)(job)).rejects.toThrow('DB unavailable');
  expect(d.send).toHaveBeenCalledTimes(1);expect(d.finish).toHaveBeenCalledTimes(1);expect(d.finish).toHaveBeenCalledWith(job.deliveryId,job.leaseToken,'sent',null);
 });
 it('rejects arbitrary destinations and body fields at the service boundary',async()=>{
  await expect(createNotificationEmailService(d)({...job,to:'attacker@example.test',body:'secret'})).rejects.toThrow();expect(d.target).not.toHaveBeenCalled();
 });
 it('requires the managed secret reference as well as matching relay settings',()=>{
  const config={...defaultEmailConfig,host:'smtp.example.test',from:'hr@example.test',user:'relay'},vaultKey='smtp-'+randomUUID();
  const smtpServer={host:config.host,port:'465',ssl:'true',starttls:'false',auth:'true',authType:'basic',from:config.from,fromDisplayName:config.fromName,replyTo:'',user:'relay',password:'${vault.'+vaultKey+'}'};
  const state={drafts:{},active:{config,vaultKey}};
  expect(activeWorkflowRelay(state,{smtpServer})).toEqual(state.active);
  for(const patch of [{password:'changed-secret'},{ssl:'false'},{host:'other.test'},{starttls:'true'}])expect(activeWorkflowRelay(state,{smtpServer:{...smtpServer,...patch}})).toBeNull();
 });
});

import { describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { notificationEmailLink,notificationEmailRequest,notificationSmtpFailure,notificationEmailCategories } from '../lib/notification-email-model';
import { workflowEmailMessage } from '../deploy/identity-email/notification-message';
import fs from 'node:fs';
describe('brief workflow email contracts',()=>{
 it('permits only same-origin application links',()=>{
  expect(notificationEmailLink('https://hr.test','/approvals?tab=pending')).toBe('https://hr.test/approvals?tab=pending');
  for(const p of ['//evil.test','https://evil.test','/\\evil.test','/a\nb','/a b',null])expect(()=>notificationEmailLink('https://hr.test',p)).toThrow();
  for(const origin of ['http://hr.test','https://u:p@hr.test','https://hr.test/base','https://hr.test?secret=x'])expect(()=>notificationEmailLink(origin,'/me')).toThrow();
 });
 it('rejects caller-supplied recipients, mail body, sender, origin and extra protocol keys',()=>{
  const job={op:'send',deliveryId:randomUUID(),leaseToken:randomUUID()};
  expect(notificationEmailRequest.safeParse(job).success).toBe(true);
  for(const field of ['to','from','body','html','origin','smtp'])expect(notificationEmailRequest.safeParse({...job,[field]:'attacker value'}).success).toBe(false);
  expect(notificationEmailRequest.safeParse({op:'status',to:'other@example.test'}).success).toBe(false);
 });
 it('only retries explicit temporary SMTP rejection; missing acknowledgement is uncertain',()=>{
  expect(notificationSmtpFailure({responseCode:451})).toEqual({outcome:'retry',error:'smtpTemporary'});
  expect(notificationSmtpFailure({responseCode:550}).outcome).toBe('failed');
  for(const e of [new Error('timeout'),{code:'ETIMEDOUT'},{code:'ESOCKET'},null])expect(notificationSmtpFailure(e)).toEqual({outcome:'uncertain',error:'uncertain'});
 });
 it('the category catalogue exactly matches the registry, so a new producer cannot be silently unconfigurable',()=>{
  const src=fs.readFileSync('core/notifications.ts','utf8'),start=src.indexOf('const REGISTRY:'),end=src.indexOf('export async function dispatchNotifications');
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+10000);
  const categories=[...src.slice(start,end).matchAll(/category:\s*'([^']+)'/g)].map(m=>m[1]);
  expect(categories.length).toBeGreaterThan(25);expect([...new Set(categories)].sort()).toEqual([...notificationEmailCategories].sort());
 });
 it('renders six translated brief alerts without accepting HR detail',()=>{
  const bodies=new Set<string>();
  for(const locale of ['en','ms','zh','vi','ta','th'] as const){
   const message=workflowEmailMessage({category:'payroll',locale,link:'https://hr.test/me?tab=pay&x=1',action:false,messageId:'stable'});
   bodies.add(message.text);expect(message.text).toContain('https://hr.test/me?tab=pay&x=1');expect(message.html).toContain('&amp;x=1');expect(message.subject).not.toContain('{category}');
   expect(message.text).not.toMatch(/salary|RM|medical|approved|rejected/i);
  }
  expect(bodies.size).toBe(6);
 });
});

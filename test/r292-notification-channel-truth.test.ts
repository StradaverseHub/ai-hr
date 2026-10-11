/** r292 remains a copy/transport agreement guard. Workflow email now exists, conditionally (ADR-0034 §7). */
import fs from 'node:fs';
import path from 'node:path';
import { describe,expect,it } from 'vitest';
const root=path.resolve(__dirname,'..'),read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8');
function walk(dir:string,out:string[]=[]):string[]{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='graphify-out')continue;const full=path.join(dir,e.name);if(e.isDirectory())walk(full,out);else if(/\.(ts|tsx)$/.test(e.name))out.push(path.relative(root,full));}return out;}
const sources=walk(root);
describe('r292 — transport and product copy describe the same conditional delivery',()=>{
 it('keeps SMTP imports in the isolated identity service, never a web action or kernel dispatcher',()=>{
  expect(Object.keys(JSON.parse(read('package.json')).dependencies)).toContain('nodemailer');
  const importers=sources.filter(f=>/from\s+['"]nodemailer(?:['"]|\/)/.test(read(f)));
  expect(importers).toEqual(['deploy/identity-email/agent.ts']);
  expect(read('core/notifications.ts')).toContain('app.notification_email_enqueue(');
  expect(read('core/notifications.ts')).not.toMatch(/sendMail\(/);
 });
 it('keeps the conditional policy and explicit consent in the enqueue operation',()=>{
  const migration=read('db/migrations/0527_workflow_email.sql');
  const start=migration.indexOf('CREATE FUNCTION app.notification_email_enqueue('),end=migration.indexOf('REVOKE ALL ON FUNCTION app.notification_email_enqueue',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+1500);
  const queue=migration.slice(start,end);
  expect(queue).toContain('pref.enabled');expect(queue).toContain('pref.email_consent_user_id=u.id');
  expect(queue).toContain('policy.enabled');expect(queue).toContain('ev.sequence>pref.email_after_sequence');expect(queue).toContain('ev.sequence>policy.after_sequence');
 });
 it('does not restore obsolete absence claims or unconditional delivery promises',()=>{
  const pathFiles=['core/notifications.ts','scripts/review-sweep.ts','core/notice.ts','test/user-lifecycle.test.ts'];
  for(const f of pathFiles){const src=read(f);expect(src,f).not.toMatch(/NO EMAIL TRANSPORT IN THIS REPOSITORY|notification_pref.*dead schema|there is no email transport in the repo|this path SENDS EMAIL|there is no email switch, because there is no email/);}
  const header=read('core/notifications.ts').slice(0,2600);
  expect(header).toMatch(/Workflow email is conditional/);expect(header).toMatch(/explicit recipient consent/);expect(header).toMatch(/SMTP acceptance is not human receipt/);
 });
 it('preserves the original login-block exclusion and its in-app lifetime rationale',()=>{
  const src=read('core/notifications.ts'),start=src.indexOf('Switched-off logins are excluded'),end=src.indexOf('export async function hrAdminsForCompany');
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+1000);
  const note=src.slice(start,end);expect(note).toContain('notification_recipient_rls');expect(note).toMatch(/rehire/);expect(src).toContain('not app.login_blocked(');
 });
 it('all six catalogues explain the category, consent and relay gates without changing the notice checkbox into an email guarantee',()=>{
  const help=new Set<string>();
  for(const loc of ['en','ms','zh','vi','ta','th']){
   const m=JSON.parse(read(`messages/${loc}.json`));
   expect(m.notices.fNotifyHelp.length).toBeGreaterThan(20);help.add(m.notices.fNotifyHelp);
   expect(m.admin.leave.cancelApprovedNotifyHelp).toBe(m.notices.fNotifyHelp);
   expect(m.workflowEmail.deliveriesHelp.length).toBeGreaterThan(30);
   expect(m.notices.fNotify).not.toMatch(/e-?mail/i);
  }
  expect(help.size).toBe(6);
  const en=JSON.parse(read('messages/en.json'));
  expect(en.notices.fNotifyHelp).toMatch(/category permission, recipient consent and an active SMTP relay/);
  expect(en.workflowEmail.deliveriesHelp).toMatch(/does not prove receipt/);
 });
});

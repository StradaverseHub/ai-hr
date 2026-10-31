/** cf588903 supersedes the six-tab/address/clocking contract, preserving own-only projection and redaction. */
import fs from 'node:fs';import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {ESS_PROFILE_TABS} from '../lib/personnel-ess-model';
import {ME_TABS,ME_TAB_LABEL_KEY,ME_HIDDEN_FIELDS,ME_VISIBLE_FIELD_LABEL_KEYS} from '../app/(app)/me/visible-fields';
const read=(name:string)=>fs.readFileSync(path.resolve(__dirname,'..',name),'utf8');
const page=read('app/(app)/me/page.tsx'),editor=read('app/(app)/me/profile-editor.tsx'),record=read('app/(app)/me/record.ts'),owner=read('core/profile-edit.ts'),view=read('core/profile-view.ts'),doc=read('docs/me-profile-field-visibility.md');
const at=(raw:unknown,key:string):unknown=>key.split('.').reduce<unknown>((value,part)=>value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined,raw);
describe('My Profile shared Personnel inventory and actual consumers',()=>{
 it('retains the exact eleven-tab order, canonical labels and a panel for every tab',()=>{
  expect([...ME_TABS]).toEqual(['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others']);
  expect(ESS_PROFILE_TABS).toEqual(['Profile','Family','Employment','Employment History','Attendance','Bank & Statutory','Payroll','Leave','Documents','Qualification','Others']);
  expect(page).toMatch(/others:tabVisible\('Others'\)\?<Card\b[^>]*>\s*<Link\s+href="\/me\/performance"/);
  for(const key of ME_TABS)expect(ME_TAB_LABEL_KEY[key]).toBe(`tabs.${key}`);
  expect(page).toContain('<ProfileEditor');expect(editor).toContain('Object.fromEntries(activeKeys.map(key=>');expect(editor).toContain('panels={panels}');expect(editor).toContain('personnelFieldLabel(field,translate)');expect(editor).toContain('personnelFieldChoices(field)');
 });
 it('accounts for every stable actual Personnel descriptor, including protected/specialist fields, in the written inventory',()=>{
  expect(PERSONNEL_FIELDS.length).toBeGreaterThan(300);expect(new Set(PERSONNEL_FIELDS.map(field=>field.id)).size).toBe(PERSONNEL_FIELDS.length);
  const rows=doc.split('\n').filter(line=>line.startsWith('| `')).map(line=>line.split('|').slice(1,-1).map(cell=>cell.trim()));
  const inventory=new Map<string,string[]>(rows.map(row=>[row[0].slice(1,-1),row]));
  expect(inventory.size,'one inventory row per stable ID').toBe(rows.length);
  expect(new Set(inventory.keys())).toEqual(new Set(PERSONNEL_FIELDS.map(field=>field.id)));
  for(const field of PERSONNEL_FIELDS){
   expect(field.sourceEvidence,field.id).toBeTruthy();expect(field.ess.reason,field.id).toBeTruthy();
   const row=inventory.get(field.id);
   expect(row?.slice(1,4),field.id).toEqual([field.tab,field.ess.visibility==='visible'?'Visible':'Protected',field.ess.edit]);
   expect(row?.[4],field.id+': written reason').toBeTruthy();
   if(field.ess.binding)expect(field.ess.visibility,field.id).toBe('visible');
  }
  expect(ME_HIDDEN_FIELDS).toHaveLength(PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='protected').length);
  for(const [index,key]of ME_TABS.entries())expect(ME_VISIBLE_FIELD_LABEL_KEYS[key]).toEqual([...new Set(PERSONNEL_FIELDS.filter(field=>field.tab===ESS_PROFILE_TABS[index]&&field.ess.visibility==='visible'&&field.labelKey.startsWith('people.detail.')).map(field=>field.labelKey.slice('people.detail.'.length)))]);
 });
 it('resolves every visible fact caption and tab in all six real catalogues',()=>{
  for(const locale of ['en','ms','zh','ta','th','vi']){const messages=JSON.parse(read(`messages/${locale}.json`));for(const field of PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible')){expect(field.labelKey,field.id).toBeTruthy();expect(typeof at(messages,field.labelKey),`${locale}:${field.id}`).toBe('string');}for(const key of ME_TABS)expect(typeof at(messages,`people.detail.${ME_TAB_LABEL_KEY[key]}`)).toBe('string');}
 });
 it('derives every subject from the authenticated own-employment set and never mounts the administrative search or full-row projection',()=>{
  expect(page).toContain('myOwnEmploymentSubjects(s,{profileEdit:true})');expect(page).toContain('own.find(row=>row.employmentId===requestedEmploymentId)');expect(page).toContain('own.length===1?own[0]:null');
  expect(record).toContain('myOwnEmploymentSubjects(ctx)');expect(owner).toContain('myOwnEmploymentSubjectsTx(tx,ctx');expect(view).toContain('subjects.find(row=>row.employmentId===employmentId)');
  for(const forbidden of ['EmployeeSwitcher','listEmployees','employeeSearch','DocumentsManager','DocumentsSection','listEmployeeDocuments'])expect(page+editor+record+view).not.toContain(forbidden);
  expect(record).not.toMatch(/\.\.\.(?:emp|statutoryRow)\b/);expect(view).toContain("field.ess.visibility!=='visible'");expect(owner).toContain("field.ess.visibility!=='visible'");
  expect(PERSONNEL_FIELDS.filter(field=>field.owner==='document').every(field=>field.ess.visibility==='protected')).toBe(true);
 });
 it('shows canonical Permanent/Correspondence plus explicit retained legacy reconciliation, with no silent copy or legacy address mutation',()=>{
  expect(owner).toContain('addressNeedsReview(master)');expect(owner).toContain('legacyAddress:addressVisible?legacyAddress(master):{}');expect(editor).toContain("t('legacyAddressHelp')");expect(editor).toContain('workspace.legacyAddress');
  for(const name of ['permanentAddressLine1','correspondenceAddressLine1'])expect(PERSONNEL_FIELDS.some(field=>field.ess.binding?.owner==='person'&&field.ess.binding.field===name)).toBe(true);
  expect(owner).not.toContain("addressLine1:text(");expect(page).not.toContain('myUpdateContact');
 });
 it('reuses canonical direct/request/decision owners with touched-only proposals and separate masked pending history',()=>{
  expect(editor).toContain('Object.hasOwn(changes,field.id)');expect(editor).toContain('workspace.baselines[field.id]');expect(editor).toContain('before:row.baselines[field.id]');expect(owner).toContain('await updateOwnContact(');expect(owner).toContain('await requestProfileChange(');expect(owner).toContain('await applyRegisterTx(tx,prepared.ctx');
  expect(page).toContain('profileProposalLines(');expect(page).toContain('{mask:true}');expect(editor).toContain("request.status==='pending'");expect(editor).toContain("t('pendingValue'");expect(editor).toContain('request.decisionReason');expect(page).not.toContain('<RequestChangeCard');
 });
 it('removes Today and clocking only from My Profile while retaining exact Attendance/Leave/Performance destinations and released documents',()=>{
  for(const forbidden of ['AttendanceClockButton','action={myCheckIn}','action={myCheckOut}','<LocationNotice','todayHeading'])expect(page+editor).not.toContain(forbidden);
  expect(page).toContain('href="/attendance"');expect(page).toContain('href="/attendance/requests"');expect(page).toContain('href="/leave"');expect(page).toContain('href="/me/performance"');
  expect(page).toContain('/me/ea/${r.employmentId}/pdf');expect(page).toContain('<MeReviewCard s={s} employmentId={employmentId}');
  const clock=read('app/(app)/attendance/clock/page.tsx'),client=read('app/(app)/attendance/clock/clock-client.tsx');expect(clock).toContain('<ClockPageClient');expect(client).toContain("fetch('/api/attendance/clock',{method:'POST'");
 });
});

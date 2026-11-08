/** Source/SSR parity only; native record binding and loaded browser evidence remain separate. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,expectTypeOf,it} from 'vitest';
import type {ME_TABS,MeTabKey} from '../app/me/visible-fields';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PERSONNEL_TAB_DEFINITIONS,PERSONNEL_RECORD_TAB_DEFINITIONS,ESS_PROFILE_TAB_DEFINITIONS,type PersonnelTabKey} from '../lib/personnel-record-navigation';
import {ESS_PROFILE_TABS} from '../lib/personnel-ess-model';
import {DRAFT_TABS,DRAFT_TAB_DEFINITIONS,openingTab,stepNumber} from '../lib/employee-draft-schema';
import {LEAVE_TYPE_TAB_DEFINITIONS,LEAVE_TYPE_WORKSPACE_CHOICE,TAB_KEYS} from '../lib/leave-type-navigation';
import {PROBATION_PREPARATION_LINKS,probationPreparationHref} from '../lib/probation-preparation-navigation';
import {declaredNestedNavigationCatalogue,NAVIGATION_COVERAGE_BACKLOG} from '../lib/navigation/catalogue';
import {ClientTabs} from '../components/personnel-tabs';
import inverse from './fixtures/navigation-inline-source-inverse.json';
const recordKeys=['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification'] as const;
it('retains actual Personnel10 and generic/ESS11, with the retired record Others distinct from ESS history',()=>{
 expectTypeOf<typeof ME_TABS>().toEqualTypeOf<readonly ['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others']>();expectTypeOf<MeTabKey>().toEqualTypeOf<PersonnelTabKey>();
 expect(PERSONNEL_RECORD_TAB_DEFINITIONS.map(tab=>tab.key)).toEqual(recordKeys);expect(PERSONNEL_TAB_DEFINITIONS.map(tab=>tab.key)).toEqual([...recordKeys,'others']);
 expect(PERSONNEL_RECORD_TAB_DEFINITIONS.map(tab=>tab.navigationId)).toEqual(recordKeys.map(key=>'nested.personnelRecord.'+key));
 expect(ESS_PROFILE_TAB_DEFINITIONS.map(tab=>[tab.key,tab.section])).toEqual([['profile','Profile'],['family','Family'],['job','Employment'],['careerMovement','Employment History'],['attendance','Attendance'],['bankStatutory','Bank & Statutory'],['payroll','Payroll'],['leave','Leave'],['documents','Documents'],['qualification','Qualification'],['others','Others']]);
 expect(ESS_PROFILE_TABS).toEqual(['Profile','Family','Employment','Employment History','Attendance','Bank & Statutory','Payroll','Leave','Documents','Qualification','Others']);
});
it('retains the draft stored-step order and native opening precedence without a second step/permission policy',()=>{
 expect(DRAFT_TABS).toEqual(['profile','job','bankStatutory','payroll','family']);expect(DRAFT_TAB_DEFINITIONS.map(tab=>tab.key)).toEqual(DRAFT_TABS);expect(DRAFT_TABS.map(stepNumber)).toEqual([1,2,3,4,6]);
 expect(openingTab('family',1)).toBe('family');expect(openingTab('attendance',2)).toBe('job');expect(openingTab(undefined,5)).toBe('payroll');
});
it('preserves actual five storage keys and one parameterized record-choice declaration',()=>{
 expect(TAB_KEYS).toEqual(['identity','eligibility','entitlement','application','approvers']);expect(LEAVE_TYPE_TAB_DEFINITIONS.map(tab=>tab.key)).toEqual(TAB_KEYS);
 for(const retired of ['approval','display','calculation'])expect(TAB_KEYS).not.toContain(retired);
 const choices=declaredNestedNavigationCatalogue().declarations.filter(row=>row.family==='leaveTypeWorkspace');expect(choices).toHaveLength(1);expect(choices[0].descriptor).toBe(LEAVE_TYPE_WORKSPACE_CHOICE);expect(choices[0].parameters).toEqual(['leaveTypeId']);expect(choices[0].href).toBeUndefined();expect(choices[0].kind).toBe('record-choice');
});
it('retains all six company preparation routes and exact label/encoding owner without copying conditional authority',()=>{
 expect(PROBATION_PREPARATION_LINKS.map(row=>[row.path,row.labelKey])).toEqual([['settings','settings.title'],['forms','form.title'],['routes','routes.title'],['workflows','workflows.title'],['templates','templates.title'],['intake','intake.title']]);
 expect(probationPreparationHref('routes','fictional/a & b')).toBe('/lifecycle/probation/routes?company=fictional%2Fa%20%26%20b');
});
it('composes exact descriptor references and preserves unexecuted scope, backlog and unsupported prior destinations',()=>{
 const c=declaredNestedNavigationCatalogue();expect(c.issues).toEqual([]);expect(c.runtimeAcceptance).toBe(false);expect(c.releaseAuthorized).toBe(false);expect(c.declarations.every(row=>row.runtime==='unexecuted')).toBe(true);expect(NAVIGATION_COVERAGE_BACKLOG.map(row=>row.id)).toContain('nested-submenus');
 const groups=[['personnelRecord',PERSONNEL_RECORD_TAB_DEFINITIONS,10],['personnelDraft',DRAFT_TAB_DEFINITIONS,5],['essProfile',ESS_PROFILE_TAB_DEFINITIONS,11],['leaveType',LEAVE_TYPE_TAB_DEFINITIONS,5],['probationPreparation',PROBATION_PREPARATION_LINKS,6]] as const;
 for(const[family,descriptors,count]of groups){expect(c.declarations.filter(row=>row.family===family)).toHaveLength(count);for(const descriptor of descriptors)expect(c.declarations.filter(row=>row.descriptor===descriptor)).toHaveLength(1);}
 expect(c.declarations.filter(row=>row.implementation==='unsupported').map(row=>row.id)).toEqual(['nested.scheduleGroup.holiday','nested.scheduleGroup.request','nested.scheduleGroup.notification']);
});
it.each(['en','ms','ta','th','vi','zh'])('SSR keeps the same ten translated Personnel tabs and initial mounted panel contract in %s',locale=>{
 const messages=JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8'));
 const tabs=PERSONNEL_RECORD_TAB_DEFINITIONS.map(tab=>({...tab,label:messages.people.detail.tabs[tab.key]})),panels=Object.fromEntries(tabs.map(tab=>[tab.key,React.createElement('input',{'aria-label':tab.key,defaultValue:'Fictional '+tab.key})]));
 const html=renderToStaticMarkup(React.createElement(ClientTabs<PersonnelTabKey>,{tabs,panels,emptyLabel:'Empty',defaultTab:'payroll'}));
 expect((html.match(/role="tab"/g)??[])).toHaveLength(10);expect((html.match(/role="tabpanel"/g)??[])).toHaveLength(10);expect((html.match(/data-navigation-panel=/g)??[])).toHaveLength(10);expect((html.match(/aria-selected="true"/g)??[])).toHaveLength(1);
 for(const tab of tabs){expect(html).toContain('data-navigation-destination="'+tab.navigationId+'"');expect(html).toContain('value="Fictional '+tab.key+'"');}
 const selected=html.match(/<button[^>]*data-navigation-destination="nested\.personnelRecord\.payroll"[^>]*>/);expect(selected?.[0]).toContain('aria-selected="true"');
 expect(html).not.toContain('nested.personnelRecord.others');
});
it('reconstructs every complete original inline owner; source parity never counts as browser execution',()=>{
 expect(inverse.base).toBe('d77fcef941a1660fc979b3231f2edf93e62f1ebe');const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(const row of inverse.files){const text=readFileSync(new URL('../'+row.path,import.meta.url),'utf8');expect(sha(text),row.path).toBe(row.candidateSha256);const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];let frontier=lines.length;for(const edit of row.edits){expect(edit.start).toBeGreaterThanOrEqual(0);expect(edit.end).toBeLessThanOrEqual(frontier);expect(lines.slice(edit.start,edit.end).join('')).toBe(edit.candidate);lines.splice(edit.start,edit.end-edit.start,...(edit.predecessor.match(/[^\n]*\n|[^\n]+$/g)??[]));frontier=edit.start;}expect(sha(lines.join('')),row.path).toBe(row.predecessorSha256);}
});

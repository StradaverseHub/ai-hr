/** Source composition only. These models never authenticate native fixture or browser coverage. */
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import inverse from './fixtures/navigation-neutral-source-inverse.json';
import {declaredNestedNavigationCatalogue,NAVIGATION_COVERAGE_BACKLOG,declaredApplicationNavigationCatalogue} from '../lib/navigation/catalogue';
import {COMPANY_PANEL_TAB_DEFINITIONS,COMPANY_PANEL_TABS,isCompanyPanelTab} from '../lib/company-panel-tabs';
import {SCHEDULE_SECTION_DEFINITIONS,SCHEDULE_SECTION_KEYS,SCHEDULE_BUILT_SECTIONS,SCHEDULE_RENDERED_SECTIONS,scheduleGroupSectionHref} from '../app/admin/attendance/schedule/sections';
import {LEAVE_CONFIG_MAP,LEAVE_CONFIG_RECORD_DEFINITIONS,leaveConfigRecordHref,leaveConfigRecordOf} from '../lib/leave-config-navigation';
import {AI_MANAGEMENT_SECTION_DEFINITIONS,availableAiManagementSections,aiManagementHref} from '../app/control-tower/agents/sections';
import {adminSectionList,adminNavigationIdentity,adminPageHref} from '../packs/performance/onehr/admin-sections';
import {V9_NAVIGATION,V9_SHARED_NAVIGATION} from '../lib/lifecycle-v9-navigation';
it('composes six source owners by descriptor reference without claiming runtime or removing the backlog',()=>{
 const c=declaredNestedNavigationCatalogue();expect(c.issues).toEqual([]);expect(c.runtimeAcceptance).toBe(false);expect(c.releaseAuthorized).toBe(false);
 expect(new Set(c.declarations.map(row=>row.family))).toEqual(new Set(['company','scheduleGroup','leaveConfig','lifecycleV9','aiManagement','performanceAdmin']));
 expect(c.declarations.every(row=>row.runtime==='unexecuted')).toBe(true);expect(NAVIGATION_COVERAGE_BACKLOG.map(row=>row.id)).toContain('nested-submenus');
 for(const descriptor of [...COMPANY_PANEL_TAB_DEFINITIONS,...SCHEDULE_SECTION_DEFINITIONS,...LEAVE_CONFIG_MAP.flatMap(g=>g.items),...LEAVE_CONFIG_RECORD_DEFINITIONS,...AI_MANAGEMENT_SECTION_DEFINITIONS,...V9_NAVIGATION,...V9_SHARED_NAVIGATION])expect(c.declarations.filter(row=>row.descriptor===descriptor)).toHaveLength(1);
 expect(declaredApplicationNavigationCatalogue().issues).toEqual([]);
});
it('retains the exact company key validator and independent metadata',()=>{
 expect(COMPANY_PANEL_TABS).toEqual(['general','bank','statutory']);expect(COMPANY_PANEL_TAB_DEFINITIONS.map(row=>row.navigationId)).toEqual(['nested.company.general','nested.company.bank','nested.company.statutory']);
 for(const value of ['general','bank','statutory'])expect(isCompanyPanelTab(value)).toBe(true);
 for(const value of ['',null,'general&tab=bank','other'])expect(isCompanyPanelTab(value)).toBe(false);
});
it('distinguishes seven declared schedule sections, built order and FOUR actual rendered tabs',()=>{
 expect(SCHEDULE_SECTION_KEYS).toEqual(['general','workingDay','holiday','overtime','attendance','request','notification']);
 expect(SCHEDULE_BUILT_SECTIONS).toEqual(['general','overtime','attendance','workingDay']);
 expect(SCHEDULE_RENDERED_SECTIONS.map(row=>row.key)).toEqual(['general','attendance','overtime','workingDay']);
 expect(declaredNestedNavigationCatalogue().declarations.filter(row=>row.implementation==='unsupported').map(row=>[row.id,row.rendered])).toEqual([
  ['nested.scheduleGroup.holiday','not-rendered'],['nested.scheduleGroup.request','not-rendered'],['nested.scheduleGroup.notification','not-rendered'],
 ]);
 expect(scheduleGroupSectionHref('fictional/a b','workingDay')).toBe('/admin/attendance/schedule/fictional%2Fa%20b?section=workingDay#section-workingDay');
});
it('preserves Leave map membership, retired omissions and record default/builders',()=>{
 expect(LEAVE_CONFIG_MAP.flatMap(g=>g.items).map(item=>item.id)).toEqual(['leaveTypes','entitlementTables','balanceHealth','adjustments','importLeaveData','leaveDataImport','leaveCredit','leaveCreditRules','generateEntitlement','earnedAccrual','approvalChain','companyRules','specialSetting']);
 expect(LEAVE_CONFIG_RECORD_DEFINITIONS.map(row=>[row.key,row.labelId])).toEqual([['configuration','entitlementArchive'],['balances','ledgerArchive']]);
 expect(leaveConfigRecordOf('unknown')).toBe('configuration');expect(leaveConfigRecordHref('balances')).toBe('/admin/leave-config/records?record=balances');
});
it('does not copy AI authority and preserves encoded canonical hrefOf context',()=>{
 expect(AI_MANAGEMENT_SECTION_DEFINITIONS.map(row=>row.key)).toEqual(['overview','provider','assistant','features','allowances','spending','orchestrator','runs']);
 expect(AI_MANAGEMENT_SECTION_DEFINITIONS.map(row=>aiManagementHref(row.key))).toEqual(['/control-tower/agents','/control-tower/agents/provider','/control-tower/agents/assistant','/control-tower/agents/features','/control-tower/agents/allowances','/control-tower/agents/spending','/control-tower/agents/orchestrator','/control-tower/agents/runs']);
 expect(availableAiManagementSections({spend:false,provider:false})).toEqual(['overview','assistant','features','allowances','orchestrator','runs']);
 expect(aiManagementHref('provider',{q:'a & b',toast:'saved',error:'fixed error',anchor:'#provider'})).toBe('/control-tower/agents/provider?q=a+%26+b&toast=saved&error=fixed+error#provider');
 expect(new URL(aiManagementHref('runs',{q:'x'.repeat(101)}),'https://local.invalid').searchParams.get('q')).toHaveLength(100);
});
it('keeps V9 source identity as aliases of the existing shell definitions, without duplicating leaves',()=>{
 const rows=declaredNestedNavigationCatalogue().declarations.filter(row=>row.family==='lifecycleV9');expect(rows).toHaveLength(11);
 const shell=declaredApplicationNavigationCatalogue().declarations;
 for(const row of rows){expect(row.kind).toBe('alias');expect(row.aliasOf).toBe(row.id);expect(shell.find(item=>item.id===row.aliasOf)?.navigationHref).toBe(row.href);}
});
it('keeps every performance section/tab/page and hidden report explicit with canonical parent targets',()=>{
 const rows=declaredNestedNavigationCatalogue().declarations.filter(row=>row.family==='performanceAdmin');
 for(const s of adminSectionList)for(const t of s.tabs)for(const p of t.pages){const row=rows.find(row=>row.id===adminNavigationIdentity(s.key,t.key,p.key));expect(row?.descriptor).toBe(p);expect(row?.parentId).toBe(adminNavigationIdentity(s.key,t.key));}
 expect(rows.filter(row=>row.rendered==='hidden').map(row=>row.id)).toEqual(['nested.performanceAdmin.reports.reports.builtByAgent']);
 expect(()=>adminPageHref('fictional-cycle','reports','reports','builtByAgent')).toThrow();
 expect(()=>adminNavigationIdentity('unknown','run')).toThrow();expect(()=>adminNavigationIdentity('cycle','unknown')).toThrow();
});

it('reconstructs all sixteen complete predecessor owners without treating source inverses as runtime evidence',()=>{
 expect(inverse.base).toBe('a90d22e287f487e8959cfb3a3c4e0b7402b8029c');expect(inverse.files).toHaveLength(16);
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),predecessors=new Map<string,string>();
 for(const file of inverse.files){
  const raw=readFileSync(new URL('../'+file.path,import.meta.url),'utf8');expect(sha(raw),file.path).toBe(file.candidateSha256);
  const lines=raw.match(/[^\n]*\n|[^\n]+$/g)??[];
  for(const edit of [...file.edits].reverse()){
   expect(lines.slice(edit.afterStart,edit.afterStart+edit.after.length),file.path).toEqual(edit.after);
   lines.splice(edit.afterStart,edit.after.length,...edit.before);
  }
  expect(sha(lines.join('')),file.path).toBe(file.predecessorSha256);predecessors.set(file.path,lines.join(''));
 }
 const moved=inverse.moved,raw=readFileSync(new URL('../'+moved.path,import.meta.url),'utf8');expect(sha(raw)).toBe(moved.candidateSha256);
 const lines=raw.match(/[^\n]*\n|[^\n]+$/g)??[];
 for(const edit of [...moved.edits].reverse()){expect(lines.slice(edit.afterStart,edit.afterStart+edit.after.length)).toEqual(edit.after);lines.splice(edit.afterStart,edit.after.length,...edit.before);}
 expect(sha(lines.join(''))).toBe(moved.predecessorSha256);
 const original=predecessors.get(moved.sourcePath);expect(original).toBeDefined();
 expect((original?.match(/[^\n]*\n|[^\n]+$/g)??[]).slice(moved.sourceStartLine,moved.sourceEndLine).join('')).toBe(lines.join(''));
});

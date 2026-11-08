/** Source composition only. Actual principal/record resolution belongs to native
 * page owners. No permissions, record UUIDs or browser acceptance are inferred. */
import {COMPANY_PANEL_TAB_DEFINITIONS} from '../company-panel-tabs';
import {SCHEDULE_SECTION_DEFINITIONS} from '../../app/admin/attendance/schedule/sections';
import {LEAVE_CONFIG_MAP,LEAVE_CONFIG_RECORD_DEFINITIONS,leaveConfigRecordHref} from '../leave-config-navigation';
import {V9_NAVIGATION,V9_SHARED_NAVIGATION} from '../lifecycle-v9-navigation';
import {AI_MANAGEMENT_SECTION_DEFINITIONS,aiManagementHref} from '../../app/control-tower/agents/sections';
import {ADMIN_GROUPS} from '../ai-centre/centre-nav';
import {adminSectionList,adminNavigationIdentity,visibleAdminPages} from '../../packs/performance/onehr/admin-sections';

export type NestedNavigationDeclaration={
 id:string; family:'company'|'scheduleGroup'|'leaveConfig'|'lifecycleV9'|'aiManagement'|'performanceAdmin';
 sourceOwner:string; rendererOwner:string; descriptor:object;
 kind:'panel'|'route'|'branch'|'alias'; parameters:readonly ('companyId'|'ruleId'|'cycleId')[];
 addressOwner:string; href?:string; parentId?:string; targetId?:string; aliasOf?:string;
 placements?:readonly {rendererOwner:string;kind:'panel'|'route'|'local-state';addressOwner:string}[];
 implementation:'built'|'unsupported'; rendered:'conditional'|'not-rendered'|'hidden';
 runtime:'unexecuted';
};
export type NestedNavigationCatalogue={declarations:NestedNavigationDeclaration[];issues:{code:string;detail:string}[];runtimeAcceptance:false;releaseAuthorized:false};
export function declaredNestedNavigationCatalogue():NestedNavigationCatalogue{
 const declarations:NestedNavigationDeclaration[]=[],issues:{code:string;detail:string}[]=[];
 for(const tab of COMPANY_PANEL_TAB_DEFINITIONS)declarations.push({id:tab.navigationId,family:'company',sourceOwner:'lib/company-panel-tabs.ts',rendererOwner:'components/company-panel.tsx',descriptor:tab,
  kind:'panel',parameters:['companyId'],addressOwner:'CompanyPanel.selectTab / organization view tabHref',placements:[{rendererOwner:'components/company-panel.tsx',kind:'panel',addressOwner:'CompanyPanel.selectTab'},{rendererOwner:'app/admin/organization/[companyId]/view/page.tsx',kind:'route',addressOwner:'tabHref'}],implementation:'built',rendered:'conditional',runtime:'unexecuted'});
 for(const section of SCHEDULE_SECTION_DEFINITIONS)declarations.push({id:section.navigationId,family:'scheduleGroup',sourceOwner:'app/admin/attendance/schedule/sections.ts',rendererOwner:'app/admin/attendance/schedule/group-sections.tsx',descriptor:section,
  kind:'panel',parameters:['ruleId'],addressOwner:'scheduleGroupSectionHref / ScheduleGroupTabs.select',implementation:section.builtOrder===null?'unsupported':'built',rendered:section.renderOrder===null?'not-rendered':'conditional',runtime:'unexecuted'});
 for(const group of LEAVE_CONFIG_MAP)for(const item of group.items)declarations.push({id:item.navigationId,family:'leaveConfig',sourceOwner:'lib/leave-config-navigation.ts',rendererOwner:'components/leave-config-map.tsx',descriptor:item,
  kind:'route',parameters:[],addressOwner:'leaveConfigScreenHref',href:item.href,implementation:'built',rendered:group.items.length>1?'conditional':'not-rendered',runtime:'unexecuted'});
 for(const record of LEAVE_CONFIG_RECORD_DEFINITIONS)declarations.push({id:record.navigationId,family:'leaveConfig',sourceOwner:'lib/leave-config-navigation.ts',rendererOwner:'app/admin/leave-config/records/page.tsx',descriptor:record,
  kind:'route',parameters:[],addressOwner:'leaveConfigRecordHref',href:leaveConfigRecordHref(record.key),implementation:'built',rendered:'conditional',runtime:'unexecuted'});
 for(const item of [...V9_NAVIGATION,...V9_SHARED_NAVIGATION])declarations.push({id:item.navigationId,family:'lifecycleV9',sourceOwner:'lib/lifecycle-v9-navigation.ts',rendererOwner:'app/lifecycle/v9/workspace.tsx',descriptor:item,
  kind:'alias',aliasOf:item.navigationId,parameters:[],addressOwner:'V9_NAVIGATION / V9_SHARED_NAVIGATION',href:item.href,placements:[{rendererOwner:'app/lifecycle/v9/workspace.tsx',kind:'local-state',addressOwner:'V9Workspace.navigate (standalone)'},{rendererOwner:'components/sidebar.tsx',kind:'route',addressOwner:'existing native shell resolver'}],implementation:'built',rendered:'conditional',runtime:'unexecuted'});
 const administration=Object.values(ADMIN_GROUPS).filter(items=>items.length>1).flat();
 for(const section of AI_MANAGEMENT_SECTION_DEFINITIONS)declarations.push({id:section.navigationId,family:'aiManagement',sourceOwner:'app/control-tower/agents/sections.ts',rendererOwner:'components/ai-centre/centre-tabs.tsx',descriptor:section,
  kind:'route',parameters:[],addressOwner:'aiManagementHref (actual hrefOf owner)',href:aiManagementHref(section.key),implementation:'built',rendered:administration.some(item=>item.section===section.key)?'conditional':'not-rendered',runtime:'unexecuted'});
 for(const section of adminSectionList){
  const parent=adminNavigationIdentity(section.key),firstTab=section.tabs[0],firstPage=visibleAdminPages(firstTab)[0];
  declarations.push({id:parent,family:'performanceAdmin',sourceOwner:'packs/performance/onehr/admin-sections.ts',rendererOwner:'app/performance/onehr/admin-shell.tsx',descriptor:section,
   kind:'branch',targetId:adminNavigationIdentity(section.key,firstTab.key,firstPage.key),parameters:['cycleId'],addressOwner:'adminSectionHref',implementation:'built',rendered:'conditional',runtime:'unexecuted'});
  for(const tab of section.tabs){
   const branch=adminNavigationIdentity(section.key,tab.key),first=visibleAdminPages(tab)[0];
   declarations.push({id:branch,parentId:parent,family:'performanceAdmin',sourceOwner:'packs/performance/onehr/admin-sections.ts',rendererOwner:'app/performance/onehr/admin-shell.tsx',descriptor:tab,
    kind:'branch',targetId:adminNavigationIdentity(section.key,tab.key,first.key),parameters:['cycleId'],addressOwner:'adminPageHref (default visible page)',implementation:'built',rendered:'conditional',runtime:'unexecuted'});
   for(const page of tab.pages)declarations.push({id:adminNavigationIdentity(section.key,tab.key,page.key),parentId:branch,family:'performanceAdmin',sourceOwner:'packs/performance/onehr/admin-sections.ts',rendererOwner:'app/performance/onehr/admin-shell.tsx',descriptor:page,
    kind:'route',parameters:['cycleId'],addressOwner:'adminPageHref (hidden report requires native report query)',implementation:'built',rendered:page.hidden?'hidden':visibleAdminPages(tab).length>1?'conditional':'not-rendered',runtime:'unexecuted'});
  }
 }
 const seen=new Set<string>();
 for(const row of declarations){if(!row.id||seen.has(row.id))issues.push({code:'duplicate-or-missing-nested-identity',detail:row.id});seen.add(row.id);}
 for(const row of declarations)if(row.targetId&&!seen.has(row.targetId))issues.push({code:'unbound-nested-target',detail:row.id});
 return{declarations,issues,runtimeAcceptance:false,releaseAuthorized:false};
}

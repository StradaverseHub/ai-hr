/** Real renderers and state transitions; model fixtures are NOT native role or loaded-browser evidence. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {messagesForLocale} from '../i18n/catalogs';
import {ScheduleGroupTabs} from '../components/schedule-group-tabs';
import {SCHEDULE_RENDERED_SECTIONS} from '../app/admin/attendance/schedule/sections';
import {AiCentreSubnav} from '../components/ai-centre/centre-tabs';
import {aiManagementHref,availableAiManagementSections} from '../app/control-tower/agents/sections';
import {LeaveConfigMap} from '../components/leave-config-map';
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi'}));
function message(value:unknown,path:string):string{
 let current=value;for(const key of path.split('.')){
  if(!current||typeof current!=='object'||!(key in current))throw Error('Missing reviewed locale message '+path);
  current=Reflect.get(current,key);
 }
 if(typeof current!=='string')throw Error('Expected locale text '+path);return current;
}
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>{
 const messages=await messagesForLocale(state.locale);return(key:string)=>message(messages,namespace+'.'+key);
}}));
afterEach(()=>{cleanup();state.locale='en';window.history.replaceState({},'','/');});
it('switches actual four Schedule tabs while retaining dirty mounted controls and canonical query/hash',()=>{
 window.history.replaceState({kept:'native-history'},'','/admin/attendance/schedule/fictional?carry=a%26b');
 const tabs=SCHEDULE_RENDERED_SECTIONS.map(section=>({id:section.key,navigationId:section.navigationId,label:section.key,body:<label>{section.key}<input defaultValue="fictional saved"/></label>}));
 const view=render(<ScheduleGroupTabs tabs={tabs} initial="general" ariaLabel="Fictional schedule sections"/>);
 const nav=within(view.getByRole('tablist'));expect(nav.getAllByRole('tab').map(tab=>tab.getAttribute('data-navigation-destination'))).toEqual(['nested.scheduleGroup.general','nested.scheduleGroup.attendance','nested.scheduleGroup.overtime','nested.scheduleGroup.workingDay']);
 const general=view.container.querySelector<HTMLInputElement>('[data-navigation-panel="nested.scheduleGroup.general"] input')!;
 fireEvent.change(general,{target:{value:'fictional unsaved'}});
 fireEvent.click(nav.getByRole('tab',{name:'attendance'}));
 expect(view.container.querySelector('[data-navigation-panel="nested.scheduleGroup.attendance"]')).toBeVisible();
 expect(view.container.querySelector('[data-navigation-panel="nested.scheduleGroup.general"]')).not.toBeVisible();
 expect(view.container.querySelectorAll('[data-navigation-panel]')).toHaveLength(4);expect(general).toHaveValue('fictional unsaved');
 expect(window.location.search).toBe('?carry=a%26b&section=attendance');expect(window.location.hash).toBe('#section-attendance');expect(window.history.state).toEqual({kept:'native-history'});
 fireEvent.keyDown(nav.getByRole('tab',{name:'attendance'}),{key:'End'});expect(nav.getByRole('tab',{name:'workingDay'})).toHaveAttribute('aria-selected','true');
 fireEvent.click(nav.getByRole('tab',{name:'general'}));expect(general).toHaveValue('fictional unsaved');
});
it('preserves Schedule legacy hash selection and never invents its three unsupported tabs',()=>{
 window.history.replaceState({},'','/admin/attendance/schedule/fictional#section-overtime');
 const view=render(<ScheduleGroupTabs tabs={SCHEDULE_RENDERED_SECTIONS.map(section=>({id:section.key,navigationId:section.navigationId,label:section.key,body:<input aria-label={section.key}/>}))} ariaLabel="Schedule"/>);
 expect(view.getByRole('tab',{name:'overtime'})).toHaveAttribute('aria-selected','true');
 for(const key of ['holiday','request','notification'])expect(view.queryByRole('tab',{name:key})).not.toBeInTheDocument();
});
it.each(['en','ms','zh','ta','th','vi'] as const)('keeps actual Leave/AI in-section choices, hrefOf and labels in %s',async locale=>{
 state.locale=locale;const messages=await messagesForLocale(locale);
 const leave=render(await LeaveConfigMap({current:'leaveTypes'}));
 const strip=leave.container.querySelector('[data-testid="leave-config-tabs"]')!;
 expect(Array.from(strip.querySelectorAll('[data-navigation-destination]')).map(node=>[node.getAttribute('data-navigation-destination'),node.textContent,node.getAttribute('href'),node.getAttribute('aria-current')])).toEqual([
  ['nested.leaveConfig.leaveTypes',message(messages,'admin.leaveConfigMap.item.leaveTypes'),null,'page'],
  ['nested.leaveConfig.entitlementTables',message(messages,'admin.leaveConfigMap.item.entitlementTables'),'/admin/leave-config/entitlement-tables',null],
 ]);leave.unmount();
 const one=render(await LeaveConfigMap({current:'companyRules'}));expect(one.container.querySelector('[data-testid="leave-config-tabs"]')).toBeNull();one.unmount();
 const hrefOf=(section:Parameters<typeof aiManagementHref>[0])=>aiManagementHref(section,{q:'Fictional & safe',anchor:'#native-section'});
 const available=availableAiManagementSections({spend:false,provider:false});
 const ai=render(<NextIntlClientProvider locale={locale} messages={messages}><AiCentreSubnav group="spend" active="allowances" available={available} hrefOf={hrefOf}/></NextIntlClientProvider>);
 const links=ai.getAllByRole('link');expect(links.map(link=>[link.getAttribute('data-navigation-destination'),link.textContent,link.getAttribute('href')])).toEqual([
  ['nested.aiManagement.allowances',message(messages,'aiCentre.subnav.allowances'),'/control-tower/agents/allowances?q=Fictional+%26+safe#native-section'],
  ['nested.aiManagement.runs',message(messages,'aiCentre.subnav.runs'),'/control-tower/agents/runs?q=Fictional+%26+safe#native-section'],
 ]);expect(links.filter(link=>link.getAttribute('aria-current')==='page')).toHaveLength(1);ai.unmount();
 const single=render(<NextIntlClientProvider locale={locale} messages={messages}><AiCentreSubnav group="workers" active="features" available={available} hrefOf={hrefOf}/></NextIntlClientProvider>);expect(single.container.querySelector('nav')).toBeNull();single.unmount();
});

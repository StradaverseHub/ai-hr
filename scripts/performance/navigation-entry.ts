/** Reviewed route/DOM addresses, never an access policy or alternate permission resolver. */
import {CENTRE_TABS} from '../../lib/ai-centre/centre-nav';
import type {NavigationScenario} from './navigation-protocol';
const AI_TAB_KEYS:Readonly<Record<string,string>>={'submenu.aiCentre.ask':'ask','submenu.aiCentre.policies':'policies'};
export const DIRECT_CONTENT_ROUTES:Readonly<Record<string,string>>={
 'shell.personnelAdmin':'/admin/personnel','shell.payrollProcess':'/payroll','shell.analytics':'/analytics','shell.rosterManager':'/roster',
};
export function navigationScenarioEntry(scenario:NavigationScenario){
 const kind=scenario.entry??'canonical-link';
 if(kind==='direct-route-content'){
  if(DIRECT_CONTENT_ROUTES[scenario.destinationId]!==scenario.href||scenario.originHref!==scenario.href)throw Error('Unreviewed direct module-content address');
  return {kind,selector:null};
 }
 if(kind==='ai-centre-tab'){
  const key=AI_TAB_KEYS[scenario.destinationId],tab=CENTRE_TABS.find(tab=>tab.key===key);
  if(!tab||tab.href!==scenario.href)throw Error('Native AI tab differs from its canonical declaration');
  return {kind,selector:'[data-ai-centre-tabs] a[href="'+scenario.href+'"]'};
 }
 if(kind!=='canonical-link')throw Error('Unknown navigation entry kind');
 return {kind,selector:'a[data-navigation-destination="'+scenario.destinationId+'"]'};
}

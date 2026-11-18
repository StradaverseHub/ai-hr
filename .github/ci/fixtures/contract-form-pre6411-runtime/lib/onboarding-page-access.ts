import type { Config } from './onboarding-model';
export type JoinerSections = {
  case:'hidden'|'view';hr:'hidden'|'view';notes:'hidden'|'view';checklist:'hidden'|'team'|'all';
  equip:'hidden'|'view'|'act';history:'hidden'|'equip'|'full';actions:'none'|'allowed';
};
export type JoinerSectionPreset = 'full'|'coord'|'fulfil'|'approver'|'custom';
export type JoinerSectionSetting = {preset:JoinerSectionPreset;s?:Partial<JoinerSections>};
export const JOINER_SECTION_PRESETS:Record<Exclude<JoinerSectionPreset,'custom'>,JoinerSections>={
  full:{case:'view',hr:'view',notes:'view',checklist:'all',equip:'act',history:'full',actions:'allowed'},
  coord:{case:'view',hr:'hidden',notes:'view',checklist:'all',equip:'act',history:'full',actions:'none'},
  fulfil:{case:'view',hr:'hidden',notes:'view',checklist:'team',equip:'act',history:'equip',actions:'none'},
  approver:{case:'hidden',hr:'hidden',notes:'hidden',checklist:'hidden',equip:'view',history:'hidden',actions:'none'},
};
export const JOINER_SECTION_ORDER={case:['hidden','view'],hr:['hidden','view'],notes:['hidden','view'],checklist:['hidden','team','all'],equip:['hidden','view','act'],history:['hidden','equip','full'],actions:['none','allowed']} as const;
export function joinerGroupSections(setting?:JoinerSectionSetting):JoinerSections {
  if(setting?.preset==='custom')return {...JOINER_SECTION_PRESETS.fulfil,...setting.s};
  return {...JOINER_SECTION_PRESETS[setting?.preset??'fulfil']};
}
/** Multiple permitted groups combine the greatest visibility per section, as in the supplied HTML.
 * HR visibility still requires the independent company HR authority at the storage boundary. */
export function joinerPageSections(config:Pick<Config,'access'|'groups'>,userId:string):JoinerSections|null {
  if(config.access.onboarding.includes(userId))return {...JOINER_SECTION_PRESETS.full};
  let result:JoinerSections|null=null;
  for(const group of config.groups){
    if(!config.access.joinerViewGroups?.includes(group.id)||!group.members.includes(userId))continue;
    const next=joinerGroupSections(config.access.joinerSections?.[group.id]);
    if(!result){result=next;continue;}
    for(const key of Object.keys(JOINER_SECTION_ORDER) as (keyof JoinerSections)[]){
      const order:readonly string[]=JOINER_SECTION_ORDER[key];
      if(order.indexOf(next[key])>order.indexOf(result[key]))Object.assign(result,{[key]:next[key]});
    }
  }
  return result;
}
export function joinerRecordAccess(config:Pick<Config,'access'|'groups'>,userId:string):boolean {
  return (config.access.recordHR??true)&&config.access.onboarding.includes(userId)||config.groups.some(group=>config.access.recordGroups?.includes(group.id)&&group.members.includes(userId));
}

/** UI payload pruning complements, but never replaces, the deterministic save boundary. */
export function joinerEditablePatch<T extends Record<string,unknown>>(patch:T,sections:JoinerSections|null|undefined):Partial<T>{
 if(!sections)return patch;
 return Object.fromEntries(Object.entries(patch).filter(([key])=>['selected','extras','equipmentOverrides','deviceType'].includes(key)?sections.equip==='act':key==='checklistOverride'?sections.checklist==='all':key==='notes'?sections.notes==='view':sections.case==='view')) as Partial<T>;
}

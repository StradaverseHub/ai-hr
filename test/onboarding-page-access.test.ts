import { expect,it } from 'vitest';
import { defaultConfig } from '../lib/onboarding-model';
import { JOINER_SECTION_PRESETS,joinerGroupSections,joinerPageSections,joinerRecordAccess } from '../lib/onboarding-page-access';
it('keeps module access separate from selected group presets and combines their greatest section visibility',()=>{
 const config=defaultConfig('owner');config.groups=[{id:'approval',name:'Approval',members:['member'],limit:0},{id:'delivery',name:'Delivery',members:['member'],limit:0}];
 expect(joinerPageSections(config,'member')).toBeNull();
 config.access.joinerViewGroups=['approval'];config.access.joinerSections={approval:{preset:'approver'},delivery:{preset:'coord'}};
 expect(joinerPageSections(config,'member')).toEqual(JOINER_SECTION_PRESETS.approver);
 config.access.joinerViewGroups.push('delivery');expect(joinerPageSections(config,'member')).toEqual(JOINER_SECTION_PRESETS.coord);
 expect(joinerPageSections(config,'other')).toBeNull();expect(joinerPageSections(config,'owner')).toEqual(JOINER_SECTION_PRESETS.full);
 const derived=joinerPageSections(config,'member')!;derived.hr='view';expect(JOINER_SECTION_PRESETS.coord.hr).toBe('hidden');
});
it('uses fulfil defaults for custom settings without granting request-record access implicitly',()=>{
 expect(joinerGroupSections({preset:'custom',s:{case:'hidden',history:'hidden'}})).toEqual({...JOINER_SECTION_PRESETS.fulfil,case:'hidden',history:'hidden'});
 const config=defaultConfig('owner');config.groups=[{id:'team',name:'Team',members:['member'],limit:0}];config.access.joinerViewGroups=['team'];
 expect(joinerRecordAccess(config,'member')).toBe(false);expect(joinerRecordAccess(config,'owner')).toBe(true);
 config.access.recordHR=false;expect(joinerRecordAccess(config,'owner')).toBe(false);config.access.recordGroups=['team'];expect(joinerRecordAccess(config,'member')).toBe(true);expect(joinerRecordAccess(config,'other')).toBe(false);
});

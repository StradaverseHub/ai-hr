/** Real declared rows/translations: equal display labels must not omit distinct policy identities. */
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PermissionMatrix} from '../app/(app)/admin/settings/profile-requests/permission-matrix';
import {essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../lib/personnel-ess-contract';
import {resolveEssVisibleIds,linkedEssFieldIds} from '../lib/personnel-ess-visibility';
import {ESS_PROFILE_TABS,PERSONNEL_ESS_SECTION_LABEL_KEYS} from '../lib/personnel-ess-model';
import {personnelFieldLabel} from '../lib/personnel-field-label';
import {profileTabPolicyKey,profileSectionPolicyKey} from '../lib/profile-edit-policy-value';
const tabs=['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'];
function text(source:unknown,path:string,fallback=path):string{
 let value=source;
 for(const key of path.split('.')){
  if(!value||typeof value!=='object'||Array.isArray(value))return fallback;
  value=(value as Record<string,unknown>)[key];
 }
 return typeof value==='string'?value:fallback;
}
afterEach(cleanup);
describe('all declared section identities survive translated heading collisions',()=>{
 it.each(['en','zh','ms','ta','th','vi'])('%s submits every stable group and field exactly once from the actual matrix',locale=>{
  const messages:unknown=JSON.parse(readFileSync(`${process.cwd()}/messages/${locale}.json`,'utf8'));
  const fields=essVisibleFields(),allowed=resolveEssEditableIds('all'),visible=resolveEssVisibleIds('all'),primary=resolveEssPrimaryEditableIds('all');
  const rows:Parameters<typeof PermissionMatrix>[0]['rows']=fields.map(field=>{
   const tabLabel=text(messages,`people.detail.tabs.${tabs[ESS_PROFILE_TABS.indexOf(field.tab as typeof ESS_PROFILE_TABS[number])]}`);
   const sectionKey=PERSONNEL_ESS_SECTION_LABEL_KEYS[field.section];
   return {id:field.id,linked:linkedEssFieldIds(field.id),tab:field.tab,section:field.section,tabLabel,
    group:`${tabLabel} · ${sectionKey?text(messages,'people.detail.'+sectionKey):field.section}`,
    label:personnelFieldLabel(field,(key,fallback)=>text(messages,key,fallback)),
    canEdit:Boolean(field.ess.binding&&['immediate','approval'].includes(field.ess.edit)),
    permission:!visible.has(field.id)?'hide':allowed.has(field.id)?'editable':'viewOnly',primaryOnly:primary.has(field.id),waiting:0};
  });
  const labels:Parameters<typeof PermissionMatrix>[0]['labels']={editable:text(messages,'essProfile.editable'),viewOnly:text(messages,'essProfile.viewOnly'),hide:text(messages,'essProfile.hide'),field:text(messages,'essProfile.field'),all:text(messages,'essProfile.selectAll'),primaryOnly:text(messages,'essProfile.primaryOnly'),waiting:text(messages,'essProfile.waiting'),groupHelp:text(messages,'essProfile.groupPermissionHelp'),tabPermission:text(messages,'essProfile.tabPermission'),sectionPermission:text(messages,'essProfile.sectionPermission')};
  const {container}=render(<form><PermissionMatrix rows={rows} labels={labels} disabled={false}/></form>);
  const form=container.querySelector('form')!;
  const expectedGroups=new Set(fields.flatMap(field=>[profileTabPolicyKey(field.tab),profileSectionPolicyKey(field.tab,field.section)]));
  // Concrete app reproduction: 37 required controls, only 34 were rendered in English.
  const data=new FormData(form);
  const missing=[...expectedGroups].filter(id=>data.getAll('groupPermission:'+id).length!==1);
  expect(missing).toEqual([]);
  expect([...form.querySelectorAll('select[name^="groupPermission:"]')]).toHaveLength(expectedGroups.size);
  for(const field of fields)expect(data.getAll('permission:'+field.id)).toHaveLength(1);
  const photo=rows.find(row=>row.id==='profile.personal_details.photo')!;
  fireEvent.click(screen.getByRole('checkbox',{name:`${photo.label}: ${labels.hide}`}));
  expect(new FormData(form).get('permission:'+photo.id)).toBe('hide');
  for(const id of expectedGroups)expect(new FormData(form).getAll('groupPermission:'+id)).toEqual(['editable']);
 });
});

// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {ProfileRoutingForm} from '../app/admin/settings/profile-requests/routing-form';
const subject='11111111-1111-4111-8111-111111111111',hr='22222222-2222-4222-8222-222222222222',revision='33333333-3333-4333-8333-333333333333';
const labels={help:'Rules use current eligible HR authority',enabled:'Enabled',name:'Rule name',approver:'HR approver',choose:'Choose',employees:'Employees',criteriaHelp:'Positive organisation criteria',remove:'Remove rule',add:'Add rule',save:'Save rules',preview:'Preview',previewFailed:'Preview failed',matched:'Matches',missing:'Missing',overlapping:'Overlap',ineligible:'Ineligible',requestTypes:'Request types',fields:'Profile fields',photo:'Profile photo',included:'Included',excluded:'Excluded',exclusionHelp:'Exclusions take priority',search:'Search',unavailable:'Unavailable — remove or replace',noApprovers:'No eligible HR approvers',noMatches:'No matching options'};
function mount(){
 const preview=vi.fn().mockResolvedValue({ok:true,matched:2,missing:0,overlapping:0,ineligible:0,fingerprint:'a'.repeat(64)}),save=vi.fn();
 const view=render(<ProfileRoutingForm policy={{version:1,enabled:true,revision,rules:[{id:revision,name:'Fictional rule',approverEmploymentId:hr,employmentIds:[subject],criteria:{}}]}} sections={[]} employees={[{id:subject,label:'B25-ONE · Fictional employee'}]} approvers={[{id:hr,label:'B25-HR · Fictional HR'}]} disabled={false} action={save} previewAction={preview} labels={labels}/>);
 const data=()=>JSON.parse(String(new FormData(view.container.querySelector('form')!).get('policy')));
 return {preview,save,data};
}
afterEach(cleanup);
describe('unified profile routing selectors',()=>{
 it('upgrades a stored positive-only rule without treating unselected employees as exclusions',()=>{
  const {data}=mount();expect(data()).toMatchObject({version:2,enabled:true,expectedRevision:revision,rules:[{employmentIds:[subject],excludedEmploymentIds:[],excludedCriteria:{},requestTypes:['fields','photo']}]});
  expect(screen.getByRole('group',{name:'Employees'})).toBeTruthy();expect(screen.getByRole('group',{name:'Excluded'})).toBeTruthy();
 });
 it('supports searchable ordinary checkboxes for inclusion and exclusion without Shift click',()=>{
  const {data}=mount();fireEvent.change(screen.getByRole('searchbox',{name:'Excluded: Search'}),{target:{value:'B25-ONE'}});
  fireEvent.click(within(screen.getByRole('group',{name:'Excluded'})).getByRole('checkbox',{name:'B25-ONE · Fictional employee'}));
  expect(data().rules[0]).toMatchObject({employmentIds:[subject],excludedEmploymentIds:[subject]});
  fireEvent.click(within(screen.getByRole('group',{name:'Excluded'})).getByRole('checkbox',{name:'B25-ONE · Fictional employee'}));expect(data().rules[0].excludedEmploymentIds).toEqual([]);
 });
 it('requires preview and invalidates its saved fingerprint after any routing change',async()=>{
  const {preview,data}=mount();expect((screen.getByRole('button',{name:'Save rules'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Preview'}));await waitFor(()=>expect(preview).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(data().previewFingerprint).toBe('a'.repeat(64)));expect((screen.getByRole('button',{name:'Save rules'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('checkbox',{name:'Profile photo'}));expect(data().rules[0].requestTypes).toEqual(['fields']);expect(data().previewFingerprint).toBeUndefined();expect((screen.getByRole('button',{name:'Save rules'}) as HTMLButtonElement).disabled).toBe(true);
 });
});

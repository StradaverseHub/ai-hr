/** Page composition regression: mocks all persistence; no database/app server required.
 * Tests action composition; domain authority and byte persistence have separate real database checks.
 */
import {Children,isValidElement,type ReactElement,type ReactNode} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const actions=vi.hoisted(()=>({photo:vi.fn(),save:vi.fn(),preview:vi.fn(),fields:vi.fn(),legacy:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string)=>key,{has:()=>false})}));
vi.mock('@/lib/authz',()=>({requireAdmin:async()=>({tenantId:'fictional',roles:['hr_admin']}),isGroupAdmin:()=>true}));
vi.mock('@/core/entitlements',()=>({getSetting:(_ctx:unknown,key:string)=>key==='ess.profile_photo_edit'?false:undefined}));
vi.mock('@/core/read',()=>({listCompanies:async()=>[],listDepartments:async()=>[],listJobGrades:async()=>[],listEmployees:async()=>[]}));
vi.mock('@/core/admin',()=>({listBusinessUnits:async()=>[],listCostCenters:async()=>[],listPositions:async()=>[]}));
vi.mock('@/core/profile-options',()=>({listAllProfileOptions:async()=>[]}));
vi.mock('@/core/org-criteria-form',()=>({buildOrgCriteriaSections:()=>[]}));
vi.mock('@/core/profile',()=>({pendingProfileChangeCountsByKey:async()=>new Map()}));
vi.mock('@/core/tenant-settings',()=>({profileChangeAllowedKeys:()=>[],profileChangeApprover:()=> 'admin'}));
vi.mock('@/core/profile-routing',()=>({profileApproverCandidates:async()=>[],readProfileRoutingPolicy:()=>({version:1,revision:'fictional-revision',enabled:false,rules:[]})}));
vi.mock('@/lib/personnel-ess-contract',()=>({essVisibleFields:()=>[],resolveEssEditableIds:()=>new Set(),resolveEssPrimaryEditableIds:()=>new Set()}));
vi.mock('@/lib/personnel-ess-visibility',()=>({resolveEssVisibleIds:()=>new Set(),linkedEssFieldIds:()=>[]}));
vi.mock('@/app/(app)/admin/settings/profile-requests/actions',()=>({
 saveOwnPhotoSettingAction:actions.photo,saveNamedProfileRoutingAction:actions.save,
 previewNamedProfileRoutingAction:actions.preview,saveProfileRequestFieldsAction:actions.fields,
 saveProfileRequestApproverAction:actions.legacy,
}));
import Page from '../app/(app)/admin/settings/profile-requests/page';
import {ProfileRoutingForm} from '../app/(app)/admin/settings/profile-requests/routing-form';
import {ProfileRoutingSetup} from '../app/(app)/admin/settings/profile-requests/routing-setup';

type ElementProps={children?:ReactNode;action?:unknown;previewAction?:unknown;[key:string]:unknown};
function descendants(node:ReactNode):ReactElement<ElementProps>[] {
 const found:ReactElement<ElementProps>[]=[];
 Children.forEach(node,child=>{if(isValidElement<ElementProps>(child)){found.push(child);found.push(...descendants(child.props.children));}});
 return found;
}
async function pageTree(){return Page({searchParams:Promise.resolve({})});}
beforeEach(()=>{
 vi.clearAllMocks();
 actions.photo.mockResolvedValue(undefined);actions.save.mockResolvedValue(undefined);
 actions.preview.mockResolvedValue({ok:true,matched:7,missing:2,overlapping:0,ineligible:0,fingerprint:'a'.repeat(64)});
});
afterEach(cleanup);

describe('Employee Change Requests actual page action composition',()=>{
 it('wires the photo form exclusively to its setting saver and passes separate named Save and Preview owners',async()=>{
  // Evaluating the actual async Page also catches omitted action imports before any render.
  const tree=await pageTree(),nodes=descendants(tree);
  const photoForms=nodes.filter(node=>node.type==='form'&&node.props.action===actions.photo);
  expect(photoForms).toHaveLength(1);
  expect(nodes.filter(node=>node.type==='form'&&node.props.action===actions.legacy)).toHaveLength(0);
  expect(nodes.some(node=>node.type===ProfileRoutingForm)).toBe(false);
  expect(nodes.some(node=>node.props.href==='/admin/settings/profile-requests/rules')).toBe(true);
  const routing=await ProfileRoutingSetup({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never});expect(routing!.props.action).toBe(actions.save);
  expect(routing!.props.previewAction).toBe(actions.preview);
  expect(nodes.filter(node=>node.type==='form'&&node.props.action===actions.preview)).toHaveLength(0);

  render(tree);
  const checkbox=screen.getByRole('checkbox',{name:'allowOwnPhoto'});
  fireEvent.click(checkbox);
  const photoForm=checkbox.closest('form');expect(photoForm).not.toBeNull();
  // Dispatch the exact action supplied by Page with bytes from its rendered form, independent of
  // React's server-action transport (which is not part of this mocked composition regression).
  await (photoForms[0].props.action as (data:FormData)=>Promise<void>)(new FormData(photoForm!));
  expect(actions.photo).toHaveBeenCalledTimes(1);
  expect((actions.photo.mock.calls[0][0] as FormData).get('enabled')).toBe('on');
  expect(actions.save).not.toHaveBeenCalled();expect(actions.preview).not.toHaveBeenCalled();
 });

 it('Preview executes the page-supplied preview owner; Save keeps its revision and never aliases Preview',async()=>{
  const routing=await ProfileRoutingSetup({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never});
  expect(routing.props.action).toBe(actions.save);expect(routing.props.previewAction).toBe(actions.preview);
  render(routing);
  fireEvent.click(screen.getByRole('button',{name:'routingPreview'}));
  await waitFor(()=>expect(actions.preview).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('status')).toHaveTextContent('routingTypeMatched: 7');
  expect(actions.save).not.toHaveBeenCalled();expect(actions.photo).not.toHaveBeenCalled();
  const previewData=actions.preview.mock.calls[0][0] as FormData;
  expect(JSON.parse(String(previewData.get('policy')))).toEqual({version:3,enabled:true,rules:[]});

  const saveButton=screen.getByRole('button',{name:'routingSave'}),form=saveButton.closest('form');
  expect(form).not.toBeNull();
  await (routing.props.action as (data:FormData)=>Promise<void>)(new FormData(form!));
  expect(actions.save).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String((actions.save.mock.calls[0][0] as FormData).get('policy')))).toEqual({version:3,expectedRevision:'fictional-revision',enabled:true,rules:[],previewFingerprint:'a'.repeat(64)});
  expect(actions.preview).toHaveBeenCalledTimes(1);expect(actions.photo).not.toHaveBeenCalled();
 });
});

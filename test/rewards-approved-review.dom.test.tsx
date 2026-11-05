import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {UploadAwardsEditor} from '../app/rewards/[unitId]/uploaded/upload-editor';
import {RewardRolePermissions} from '../app/admin/rewards/access/role-permissions';
const ports=vi.hoisted(()=>({change:vi.fn(),reset:vi.fn(),refresh:vi.fn(),preview:vi.fn(),saveUpload:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/admin/rewards/access/policy-actions',()=>({rewardPermissionAction:ports.change,resetRewardPermissionsAction:ports.reset}));
vi.mock('../app/rewards/[unitId]/uploaded/actions',()=>({previewUploadedAction:ports.preview,saveUploadedAction:ports.saveUpload}));
beforeEach(()=>{vi.clearAllMocks();ports.change.mockResolvedValue({ok:true});ports.reset.mockResolvedValue({ok:true});});afterEach(cleanup);
const show=(values:Parameters<typeof RewardRolePermissions>[0]['values']=[])=>render(<NextIntlClientProvider locale="en" messages={en}><RewardRolePermissions values={values} holders={[{role:'gr',name:'Fictional Rewards lead',proxy:false}]}/></NextIntlClientProvider>);
describe('approved role permissions interaction',()=>{
 it('shows all nine fixed roles and immutable own-line denies without edit controls',()=>{show();for(const role of Object.values(en.rewardAccessPolicy.roles))expect(screen.getAllByText(role).length).toBeGreaterThan(0);const row=screen.getByText(en.rewardAccessPolicy.permissions.own.never).closest('tr')!;expect(row.querySelectorAll('button')).toHaveLength(0);expect(row.textContent).toContain(en.rewardAccessPolicy.levels.never);});
 it('requires a reason before changing a native page capability and refreshes only after save',async()=>{show();fireEvent.click(screen.getByRole('button',{name:/BU CEO.*Compensation Review/i}));const save=screen.getByRole('button',{name:en.rewardAccessPolicy.save});expect(save.hasAttribute('disabled')).toBe(true);fireEvent.change(screen.getByRole('textbox'),{target:{value:'Reviewed temporary page restriction'}});fireEvent.click(save);await waitFor(()=>expect(ports.change).toHaveBeenCalledWith(expect.objectContaining({role:'bu',capability:'review.view',allowed:false,reason:'Reviewed temporary page restriction'})));expect(ports.refresh).toHaveBeenCalledTimes(1);});
 it('resets editable overrides atomically with a reason',async()=>{show([{role:'bu',capability:'review.view',allowed:false}]);fireEvent.click(screen.getByRole('button',{name:en.rewardAccessPolicy.reset}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'Restore approved default permissions'}});fireEvent.click(screen.getByRole('button',{name:en.rewardAccessPolicy.save}));await waitFor(()=>expect(ports.reset).toHaveBeenCalledWith('Restore approved default permissions'));expect(ports.change).not.toHaveBeenCalled();});
});

it('captures the populated role permission matrix and reason control',async()=>{
 const view=show([{role:'bu',capability:'review.view',allowed:false}]);
 fireEvent.click(screen.getByRole('button',{name:/BU CEO.*Compensation Review/i}));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Restore the reviewed BU page permission'}});
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-role-permissions','Actual role matrix and reason form; fictional role holder and write port.');
},60000);

it('previews an uploaded file with row diagnostics, disables save and captures the actual controls',async()=>{
 const id='30000000-0000-4000-8000-000000000010';
 ports.preview.mockResolvedValue({ok:true,preview:{revision:5,accepted:[{employmentId:'30000000-0000-4000-8000-000000000011',employeeCode:'E-101',name:'Fictional award recipient',incrementType:'merit',newBasicCents:550000,bonusCents:10000,lumpCents:0}],rejected:[{row:3,reason:'Enter a valid nonnegative amount.'}],warnings:[{employmentId:'30000000-0000-4000-8000-000000000011',code:'notice'}],totals:{people:1,payrollCents:500000,incrementCents:50000,incrementBp:1000,bonusCents:10000,lumpCents:0}}});
 const view=render(<NextIntlClientProvider locale="en" messages={en}><UploadAwardsEditor unitId={id}/></NextIntlClientProvider>);
 const file=Object.assign(new File(['fictional'], 'review-awards.csv',{type:'text/csv'}),{text:async()=> 'fictional'});
 fireEvent.change(screen.getByLabelText(en.rewardUploaded.chooseFile),{target:{files:[file]}});
 expect((await screen.findByRole('status')).textContent).toContain('1');
 expect(screen.getByText(/3: Enter a valid nonnegative amount/)).toBeTruthy();
 expect(screen.getByText(/Fictional award recipient · E-101/)).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Reviewed external company award file'}});
 expect(screen.getByRole('button',{name:en.rewardUploaded.save}).hasAttribute('disabled')).toBe(true);
 expect(ports.preview).toHaveBeenCalledWith(id,{csv:'fictional',name:'review-awards.csv'});
 expect(ports.saveUpload).not.toHaveBeenCalled();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-upload-preview','Actual upload editor and preview controls; fictional preview returned by the test action port.');
},60000);

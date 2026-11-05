import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {RewardRolePermissions} from '../app/admin/rewards/access/role-permissions';
const ports=vi.hoisted(()=>({change:vi.fn(),reset:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/admin/rewards/access/policy-actions',()=>({rewardPermissionAction:ports.change,resetRewardPermissionsAction:ports.reset}));
beforeEach(()=>{vi.clearAllMocks();ports.change.mockResolvedValue({ok:true});ports.reset.mockResolvedValue({ok:true});});afterEach(cleanup);
const show=(values:Parameters<typeof RewardRolePermissions>[0]['values']=[])=>render(<NextIntlClientProvider locale="en" messages={en}><RewardRolePermissions values={values} holders={[{role:'gr',name:'Fictional Rewards lead',proxy:false}]}/></NextIntlClientProvider>);
describe('approved role permissions interaction',()=>{
 it('shows all nine fixed roles and immutable own-line denies without edit controls',()=>{show();for(const role of Object.values(en.rewardAccessPolicy.roles))expect(screen.getAllByText(role).length).toBeGreaterThan(0);const row=screen.getByText(en.rewardAccessPolicy.permissions.own.never).closest('tr')!;expect(row.querySelectorAll('button')).toHaveLength(0);expect(row.textContent).toContain(en.rewardAccessPolicy.levels.never);});
 it('requires a reason before changing a native page capability and refreshes only after save',async()=>{show();fireEvent.click(screen.getByRole('button',{name:/BU CEO.*Compensation Review/i}));const save=screen.getByRole('button',{name:en.rewardAccessPolicy.save});expect(save.hasAttribute('disabled')).toBe(true);fireEvent.change(screen.getByRole('textbox'),{target:{value:'Reviewed temporary page restriction'}});fireEvent.click(save);await waitFor(()=>expect(ports.change).toHaveBeenCalledWith(expect.objectContaining({role:'bu',capability:'review.view',allowed:false,reason:'Reviewed temporary page restriction'})));expect(ports.refresh).toHaveBeenCalledTimes(1);});
 it('resets editable overrides atomically with a reason',async()=>{show([{role:'bu',capability:'review.view',allowed:false}]);fireEvent.click(screen.getByRole('button',{name:en.rewardAccessPolicy.reset}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'Restore approved default permissions'}});fireEvent.click(screen.getByRole('button',{name:en.rewardAccessPolicy.save}));await waitFor(()=>expect(ports.reset).toHaveBeenCalledWith('Restore approved default permissions'));expect(ports.change).not.toHaveBeenCalled();});
});

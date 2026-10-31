import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {HomePersonPrivacySection} from '../components/employee-home/person-privacy-section';
const state=vi.hoisted(()=>({read:vi.fn(),save:vi.fn()}));
vi.mock('../core/employee-home-person-privacy',()=>({readOwnHomePersonPrivacy:state.read}));
vi.mock('../app/(app)/me/home/privacy-actions',()=>({saveHomePersonPrivacyAction:state.save}));
vi.mock('next/navigation',()=>({unstable_rethrow:()=>{}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:keyof typeof en.employeeHome.personPrivacy)=>en.employeeHome.personPrivacy[key])}));
const session={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
async function mount(saved=false){render(<NextIntlClientProvider locale="en" messages={en}>{await HomePersonPrivacySection({session,saved})}</NextIntlClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();});afterEach(cleanup);
describe('Celebration privacy read failure boundary',()=>{
 it('shows a reload path with no editable defaults when the saved choice read fails',async()=>{
  state.read.mockRejectedValue(Error('Private diagnostic'));await mount(true);
  expect(screen.getByRole('alert')).toHaveTextContent(en.employeeHome.personPrivacy.loadFailed);
  expect(screen.getByRole('alert')).not.toHaveTextContent('Private diagnostic');
  expect(screen.getByRole('link',{name:en.employeeHome.personPrivacy.reload})).toHaveAttribute('href','/me/home');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(state.save).not.toHaveBeenCalled();
 });
 it('does not confuse an unlinked account with failed data or allow it to submit choices',async()=>{
  state.read.mockResolvedValue(null);await mount(true);expect(screen.getByText(en.employeeHome.personPrivacy.unlinked)).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(state.save).not.toHaveBeenCalled();
 });
 it('renders the current saved person-wide revision without writing on read',async()=>{
  state.read.mockResolvedValue({version:1,ordinal:5,hideBirthday:true,hideAnniversary:false});await mount();
  expect(state.read).toHaveBeenCalledWith(session);
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday})).toBeChecked();expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideAnniversary})).not.toBeChecked();
  expect(screen.getByRole('button',{name:en.employeeHome.personPrivacy.save}).closest('form')?.querySelector('input[name="expectedOrdinal"]')).toHaveValue('5');expect(state.save).not.toHaveBeenCalled();
 });
 it('does not turn a saved query parameter into confirmation when no revision exists',async()=>{
  state.read.mockResolvedValue({version:1,ordinal:0,hideBirthday:false,hideAnniversary:false});await mount(true);
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday})).not.toBeChecked();expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(state.save).not.toHaveBeenCalled();
 });
});

import {describe,it,expect,vi} from 'vitest';
import {render,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import viMessages from '../messages/vi.json';
import {ArchitectureWorkspaceClient} from '../app/admin/job-architecture/workspace';
import type {ArchitectureWorkspace} from '../packs/job-architecture/owner';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/job-architecture/actions',()=>({architectureAction:vi.fn(async()=>({saved:true}))}));
const companyId='11111111-1111-4111-8111-111111111111';
const workspace=():ArchitectureWorkspace=>({employeeGradeCoverage:true,catalogue:{revision:0,catalogue:{nodes:[],ladder:[]}},companies:[{id:companyId,name:'Company',canPropose:true,canCheck:false}],positions:[],businessUnits:[],publications:[],suggestions:[],suggestionMetrics:[],employees:[],proposals:[],outliers:[],grades:[],global:{canPropose:true,canProposeCatalogue:true,canCheck:false,canConfigure:false},sourceDigest:'a'.repeat(64)});
const locales={en,ms,zh,th,ta,vi:viMessages};
function mount(tab:'ladder'|'catalogue'|'positions'|'outliers',locale:keyof typeof locales='en',w=workspace()){return render(<NextIntlClientProvider locale={locale} messages={locales[locale]} onError={error=>{throw error;}}><ArchitectureWorkspaceClient w={w} tab={tab} companyId={companyId} people={[]} actorId={companyId} adviceReviewed={false}/></NextIntlClientProvider>);}
describe('architecture observable workspace',()=>{
 it.each(Object.keys(locales) as (keyof typeof locales)[])('renders every tab with complete messages in %s',locale=>{for(const tab of ['ladder','catalogue','positions','outliers'] as const){const screen=mount(tab,locale);expect(screen.container.querySelector('form')).toBeTruthy();expect(screen.container.textContent).not.toContain('jobArchitecture.');screen.unmount();}});
 it('keeps future tracks visibly inactive and AI gated pending disclosure review',async()=>{const screen=mount('ladder');await userEvent.click(screen.getByText(en.jobArchitecture.futureTrack));expect(screen.getByText(/H3 ·/)).toHaveTextContent(en.jobArchitecture.notInUse);expect(screen.getByRole('status')).toHaveTextContent(en.jobArchitecture.advicePending);expect(screen.getByRole('button',{name:en.jobArchitecture.requestAdvice})).toBeDisabled();expect(screen.queryByRole('option',{name:'H3'})).toBeNull();});
 it('adds an editable catalogue record with business fields and a reason, without exposing JSON editors',async()=>{const screen=mount('catalogue');await userEvent.click(screen.getByRole('button',{name:en.jobArchitecture.addRecord}));const record=screen.getByRole('group',{name:en.jobArchitecture.newRecord});expect(within(record).getByLabelText(en.jobArchitecture.code)).toBeVisible();await userEvent.type(within(record).getByLabelText(en.jobArchitecture.name),'Finance');expect(screen.container.querySelector('textarea[name="payload"]')).toBeNull();expect(screen.getByLabelText(en.jobArchitecture.reason,{exact:false})).toBeRequired();});
});

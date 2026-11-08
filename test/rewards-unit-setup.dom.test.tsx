// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {resolveServerTree} from './helpers/server-tree';
import {emptyRewardPreparation} from '../packs/rewards/preparation-model';
const copies={en,ms,zh,ta,th,vi:viCopy};
const state=vi.hoisted(()=>({locale:'en' as keyof typeof copies,canEdit:true}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:'rewards'|'rewardsPreparation'|'rewards.governance'|'rewardSetup'|'onehr')=>createTranslator({locale:state.locale,messages:copies[state.locale],namespace})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fictional-tenant',userId:'fictional-gr'}})}));
vi.mock('../app/rewards/preparation-actions',()=>({preparationAction:vi.fn()}));
vi.mock('../app/rewards/actions',()=>({importOnehrAction:vi.fn(),importFactsAction:vi.fn(),previewSourceRefreshAction:vi.fn(),saveSourceRefreshAction:vi.fn(),payWindowKeepAction:vi.fn()}));
vi.mock('../app/rewards/governance-actions',()=>({adoptCompanyPatAction:vi.fn(),refreshCompanyPatBasisAction:vi.fn(),unitInputsAction:vi.fn(),exemptionAction:vi.fn(),confirmGovernanceAction:vi.fn(),seniorAwardAction:vi.fn()}));
vi.mock('../packs/rewards/service',()=>({
 getRewardPreparationChecklist:async()=>({unitId:'unit',revision:8,snapshotDate:'2026-01-01',basis:'a'.repeat(64),canEdit:state.canEdit,branch:false,budgetInputs:null,preparation:{...emptyRewardPreparation(),expectedRelease:'2026-11-30'},checks:{snapshot:true,data:true,excluded:true,senior:true,budget:true,applied:true},access:{required:true,setupVisible:true,isGr:state.canEdit,independentChecker:false,actorNames:{},history:[],applied:{salary:{name:'Fictional salary structure',version:2,confirmed:true},bonus:{name:'Fictional bonus matrix',version:3,confirmed:true}},origin:{name:'Fictional shared configuration',revision:4}}}),
 getRewardUnitGovernance:async()=>({available:true,unitId:'unit',revision:8,isGr:state.canEdit,canEdit:state.canEdit,canAmounts:false,inputs:{forecastCents:10000000,actualCents:11000000,targetCents:10000000,multiplierBp:10000,branchRatings:{},targetMonthsBp:20000},legacyInputs:null,pools:{standard:200000,h:50000},poolStatus:'final',branches:[],history:[],selection:{confirmedBy:'fictional-checker'},exemption:null,senior:[],companyPatBound:true}),
 getRewardUnit:async()=>({companyName:'Fictional Company',name:'Fictional Unit',unit:{policy:{blockedFrom:'2026-01-01',blockedTo:'2026-03-31',payWindowKeep:{}}},rows:[]}),
}));
import SetupPage from '../app/rewards/[unitId]/setup/page';
afterEach(()=>{cleanup();state.canEdit=true;});
async function show(){const tree=await resolveServerTree(await SetupPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({})}));return render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale]} onError={error=>{throw error;}}>{tree}</NextIntlClientProvider>);}
describe('annual Unit set-up real components',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('renders six checks and an unavailable self-release in %s',async locale=>{
  state.locale=locale;const view=await show();expect(screen.getAllByRole('button',{name:copies[locale].rewardsPreparation.confirm})).toHaveLength(6);expect(screen.getByRole('button',{name:copies[locale].rewardsPreparation.release})).toBeDisabled();
  expect(screen.getByRole('link',{name:copies[locale].rewardsPreparation.review})).toHaveAttribute('href','/rewards/unit');
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'rewards-unit-setup');
 },60000);
 it('renders CTRO/EC setup as read-only without doer or release actions',async()=>{
  state.locale='en';state.canEdit=false;await show();expect(screen.queryByRole('button',{name:en.rewardsPreparation.confirm})).toBeNull();expect(screen.getByRole('button',{name:en.rewardsPreparation.release})).toBeDisabled();expect(screen.getByText(en.rewardsPreparation.readOnly)).toBeTruthy();
 });
});

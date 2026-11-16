// Lane M3: Access is drawn inside Probation settings (prototype) and on its own page. Each command returns to the page
// whose form sent it, with the message, and only to one of those two addresses. The service is mocked; its authority
// is covered by test/probation-access-roles-db.test.ts. Fictional data.
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';

const m=vi.hoisted(()=>({redirect:vi.fn((url:string)=>{throw Object.assign(new Error('NEXT_REDIRECT'),{url});}),revalidate:vi.fn(),save:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:m.redirect,unstable_rethrow:(error:unknown)=>{if(error instanceof Error&&error.message==='NEXT_REDIRECT')throw error;}}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'probationAccess'})}));
vi.mock('../lib/scoped-lifecycle-page',()=>({requireScopedLifecycleModule:async()=>({tenantId:'t',userId:'u'})}));
vi.mock('../lib/public-error',()=>({publicErrorMessage:(error:unknown)=>error instanceof Error?error.message:'Refused'}));
vi.mock('../packs/probation/service',()=>({saveProbationSuperiorRule:m.save,saveProbationAccessRole:vi.fn(),retireProbationAccessRole:vi.fn(),addProbationAccessMember:vi.fn(),changeProbationAccessMember:vi.fn(),revokeProbationAccessMember:vi.fn()}));
import {saveSuperiorRuleAction} from '../app/lifecycle/probation/access/actions';

const form=(returnTo?:string)=>{const data=new FormData();data.set('enabled','on');data.set('view','on');data.set('revision','3');if(returnTo)data.set('returnTo',returnTo);return data;};
const target=async(data:FormData)=>{try{await saveSuperiorRuleAction(data);}catch(error){return (error as {url?:string}).url;}throw new Error('expected a redirect');};

beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue(undefined);});

describe('Probation Access commands return to the page that sent them',()=>{
 it('returns to Probation settings at the Access section',async()=>{
  expect(await target(form('settings'))).toBe('/lifecycle/probation/settings?toast='+encodeURIComponent(en.probationAccess.superiors.saved)+'#access');
  expect(m.revalidate).toHaveBeenCalledWith('/lifecycle/probation/settings');
  expect(m.save).toHaveBeenCalledWith({tenantId:'t',userId:'u'},{enabled:true,view:true,recordDeclined:false,expectedRevision:3});
 });

 it('returns to /lifecycle/probation/access by default and for any other value',async()=>{
  expect(await target(form())).toBe('/lifecycle/probation/access?toast='+encodeURIComponent(en.probationAccess.superiors.saved));
  expect(await target(form('https://example.invalid/'))).toBe('/lifecycle/probation/access?toast='+encodeURIComponent(en.probationAccess.superiors.saved));
 });

 it('carries a refusal back to the same page',async()=>{
  m.save.mockRejectedValue(new Error('Refused for this fictional viewer.'));
  expect(await target(form('settings'))).toBe('/lifecycle/probation/settings?error='+encodeURIComponent('Refused for this fictional viewer.')+'#access');
  expect(m.revalidate).not.toHaveBeenCalled();
 });
});

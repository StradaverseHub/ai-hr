import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
import messages from '../messages/en.json';
const mock=vi.hoisted(()=>({reviews:vi.fn(),assignments:vi.fn(),record:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'tenant',userId:'employee',personId:'person'})}));
vi.mock('../app/(app)/me/actions',()=>({myCreateGoal:vi.fn(),myDeclinePeerFeedback:vi.fn(),mySubmitPeerFeedback:vi.fn(),myUpdateGoalProgress:vi.fn()}));
vi.mock('../packs/performance/service',()=>({myReviews:mock.reviews,onehrAssignments:mock.assignments,getAssessmentPersonalRecord:mock.record,myGoals:async()=>[],myCheckIns:async()=>[],myFeedbackRequests:async()=>[]}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');},useRouter:()=>({push:vi.fn()})}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never})};});
vi.mock('../app/(app)/performance/workspace/personal-record',()=>({PersonalRecord:({v,baseHref}:{v:{selected:{name:string}};baseHref:string})=><div data-testid="personal-record" data-href={baseHref}>{v.selected.name}</div>}));
vi.mock('../app/(app)/performance/workspace/record-drawer',()=>({RecordDrawer:({children,title,returnTo}:{children:ReactNode;title:string;returnTo:string})=><section aria-label={title}>{children}<a href={returnTo}>Close record</a></section>}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({askPerformanceGuideAction:vi.fn()}));
import MyPerformancePage from '../app/(app)/me/performance/page';
const id='7a1abb6e-7e3e-4f5e-bca6-04fb721e6935',other='654e0910-f9ae-472e-89cb-50b907a78e89';
beforeEach(()=>{cleanup();vi.clearAllMocks();mock.reviews.mockResolvedValue([{reviewId:id,cycleName:'Previous annual review',status:'submitted',periodEnd:'2025-12-31'}]);mock.assignments.mockResolvedValue({reviews:[{id,name:'Nadia',cycle:'Previous annual review',cycleStatus:'closed',periodEnd:'2025-12-31'},{id:other,name:'Someone else',cycle:'Team cycle',cycleStatus:'closed',periodEnd:'2025-12-31'}],sessions:[],feedback:[]});mock.record.mockResolvedValue({current:null,selected:{name:'Previous annual review'}});});
async function open(query:Record<string,string>={}){render(<NextIntlClientProvider locale="en" messages={messages}>{await MyPerformancePage({searchParams:Promise.resolve(query)})}</NextIntlClientProvider>);}
describe('Personal history entry after all cycles close',()=>{
 it('offers a record entry for own closed reviews without needing an active workspace',async()=>{await open();expect(screen.getByRole('link',{name:'Record · Previous annual review'}).getAttribute('href')).toBe(`/me/performance?recordFor=${id}&record=${id}`);expect(screen.queryByRole('link',{name:'Record · Team cycle'})).toBeNull();expect(mock.record).not.toHaveBeenCalled();});
 it('opens the existing released-record drawer and preserves its anchor for record and plan navigation',async()=>{await open({recordFor:id,record:id,recordTab:'plans',planYear:'2026'});expect(mock.record).toHaveBeenCalledWith(expect.objectContaining({userId:'employee'}),id,id,2026);expect(screen.getByTestId('personal-record').getAttribute('data-href')).toBe(`/me/performance?recordFor=${id}`);expect(screen.getByRole('link',{name:'Close record'}).getAttribute('href')).toBe('/me/performance');});
 it('refuses another person’s record before calling the private record projection',async()=>{await expect(open({recordFor:other,record:other})).rejects.toThrow('NOT_FOUND');expect(mock.record).not.toHaveBeenCalled();});
});

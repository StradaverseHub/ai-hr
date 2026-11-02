import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
const source=vi.hoisted(()=>({review:vi.fn(),standard:vi.fn(),session:{userId:'actual-session'}}));
vi.mock('../packs/performance/service',()=>({getOnehrReviewForPurpose:source.review}));
vi.mock('../lib/session',()=>({getSession:async()=>source.session}));
vi.mock('next-intl/server',()=>({getTranslations:async()=> (key:string)=>key}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
vi.mock('../core/performance',()=>({reviewForViewer:source.standard,reviewGoals:vi.fn(),peerFeedbackForReview:vi.fn()}));
vi.mock('../core/ai-config',()=>({isAiConfigured:vi.fn()}));
vi.mock('../app/performance/actions',()=>({acknowledgeAction:vi.fn(),linkGoalAction:vi.fn(),requestPeerFeedbackAction:vi.fn(),submitSelfAction:vi.fn(),submitStageManagerAction:vi.fn(),submitStageSelfAction:vi.fn(),unlinkGoalAction:vi.fn(),uploadAttachmentAction:vi.fn()}));
vi.mock('../app/performance/review/[reviewId]/manager-review-form',()=>({ManagerReviewForm:()=>null}));
vi.mock('../app/performance/onehr/review-view',()=>({OnehrReviewView:({v,returnTo}:{v:{purpose:string};returnTo?:string})=><div data-testid="review" data-purpose={v.purpose} data-return={returnTo}/> }));
import ReviewPage from '../app/performance/review/[reviewId]/page';
const props=(purpose?:string|string[])=>({params:Promise.resolve({reviewId:'actual-review'}),searchParams:Promise.resolve({purpose})});
beforeEach(()=>{cleanup();vi.clearAllMocks();source.standard.mockResolvedValue(null);source.review.mockImplementation(async(_ctx,_id,purpose)=>({purpose:purpose??'task'}));});
it('opens explicit Administrative and default task sources and preserves selected return purpose',async()=>{
 render(await ReviewPage(props('administration')));expect(source.review).toHaveBeenCalledWith(source.session,'actual-review','administration');expect(screen.getByTestId('review').dataset).toMatchObject({purpose:'administration',return:'/performance/review/actual-review?purpose=administration'});expect(source.standard).not.toHaveBeenCalled();cleanup();
 render(await ReviewPage(props()));expect(source.review).toHaveBeenLastCalledWith(source.session,'actual-review',undefined);expect(screen.getByTestId('review').dataset.purpose).toBe('task');
});
it('does not fall back from denied selected Administration to another review course',async()=>{
 source.review.mockResolvedValue(null);await expect(ReviewPage(props('administration'))).rejects.toThrow('NOT_FOUND');expect(source.review).toHaveBeenCalledTimes(1);expect(source.standard).not.toHaveBeenCalled();
});
it('rejects unknown and repeated mixed purposes before reading either source',async()=>{
 for(const purpose of ['unknown',['task','administration']])await expect(ReviewPage(props(purpose))).rejects.toThrow('NOT_FOUND');expect(source.review).not.toHaveBeenCalled();expect(source.standard).not.toHaveBeenCalled();
});

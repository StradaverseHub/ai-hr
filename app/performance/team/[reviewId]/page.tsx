import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { getOnehrReview, performanceTabAccess } from '@/packs/performance/service';
import { TEAM_REVIEW_PATH } from '@/packs/performance/onehr/tab-route-model';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { OnehrReviewView } from '../../onehr/review-view';

/**
 * D-P1-32 PT-X2 — Team PM's per-review route: the existing review screen for a review the viewer leads, under
 * the PM strip with Team PM lit. 404 when the Team PM tab is hidden, for an id that is not a review id, for a
 * review that does not exist, and for one the viewer does not lead (their own review, or an administrator-only
 * view, which /performance/review/<id> keeps serving). Saves return here.
 */
export default async function TeamReviewPage({params,searchParams}:{params:Promise<{reviewId:string}>;searchParams:Promise<{error?:string}>}) {
 await requireModule('performance');const {s}=await scopedSession();
 const [{reviewId},{error}]=await Promise.all([params,searchParams]),path=`/performance/team/${reviewId}`;
 if(!TEAM_REVIEW_PATH.test(path))notFound();
 const {mayOpen,facts}=await performanceTabAccess(s,'pm.team');
 if(!mayOpen)notFound();
 const review=await getOnehrReview(s,reviewId);
 if(!review||!(review.manager||review.moderator||review.reviewer))notFound();
 return <div className="space-y-3"><div className="mx-auto max-w-[100rem]"><PerformanceTabStrip strip="pm" facts={facts}/></div><OnehrReviewView v={review} error={error} returnTo={`${path}?`}/></div>;
}

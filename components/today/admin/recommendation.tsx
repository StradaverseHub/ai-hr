import {Suspense,cache} from 'react';
import type {SessionContext} from '@/db/client';
import {readApprovalRecommendations} from '@/app/approvals/leave-recommendations';
import {RecommendationPanel} from '@/components/ai-centre/leave-recommendation';
import {PanelBoundary} from '../employee/panel-boundary';

/** Manager Today (owner decision, 11 Nov 2026: the leave recommendation inline, nothing else): the approver
 * recommendation under each leave decision the Decide panel shows.
 *
 * It is the approvals page's own read (app/approvals/leave-recommendations.tsx readApprovalRecommendations), unchanged:
 * it runs only while the recommender may run, only for the leave requests assigned to this manager now, and the
 * recommender (core/recommenders/leave-decision.ts) checks balance, overlap, team cover and policy through the leave
 * owners and records its own outcome record. It recommends approving or asks for the manager's review, never rejecting,
 * and it decides nothing: the manager opens the request and decides there. Only the leave requests the panel shows are
 * read (at most DECISIONS_SHOWN), once for the render, and each row waits inside its own Suspense and error boundary,
 * so the list itself never waits for a recommendation. */
const readRecommendations=cache((session:SessionContext,key:string)=>readApprovalRecommendations(session,key.split(',').filter(Boolean)));

export function DecisionRecommendation({session,leaveRequestId,leaveIds,checking}:{session:SessionContext;leaveRequestId:string;leaveIds:readonly string[];checking:string}){
 return <PanelBoundary fallback={null}>
  <Suspense fallback={<p aria-busy="true" data-recommendation-pending className="m-0 mt-2 text-xs text-muted-foreground">{checking}</p>}>
   <Recommendation session={session} leaveRequestId={leaveRequestId} leaveIds={leaveIds}/>
  </Suspense>
 </PanelBoundary>;
}

async function Recommendation({session,leaveRequestId,leaveIds}:{session:SessionContext;leaveRequestId:string;leaveIds:readonly string[]}){
 const recommendations=await readRecommendations(session,leaveIds.join(','));
 const view=recommendations.views.get(leaveRequestId);
 if(!view)return null;
 return <div data-today-recommendation={leaveRequestId} className="mt-2"><RecommendationPanel view={view} inset={false}/></div>;
}

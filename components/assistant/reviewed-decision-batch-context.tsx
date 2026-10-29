'use client';
import {createContext,useContext,useEffect,useRef} from 'react';
export type BatchReview={actionId:string;reviewedDigest:string;expiresAt:string};
export type SelectedDecision=BatchReview&{confirm:()=>Promise<void>};
export type DecisionBatch={busy:boolean;register:(entry:SelectedDecision)=>()=>void};
export const ReviewedDecisionBatchContext=createContext<DecisionBatch|null>(null);
/** Registration is the individual full-card checkbox, never index membership. Capture the
 * current dispatch through a ref; later renders cannot change the frozen review identity. */
export function useReviewedDecisionBatch(review:BatchReview|null,selected:boolean,confirm:()=>Promise<void>){
 const batch=useContext(ReviewedDecisionBatchContext),call=useRef(confirm);call.current=confirm;
 const id=review?.actionId,digest=review?.reviewedDigest,expiry=review?.expiresAt,register=batch?.register;
 useEffect(()=>{if(!register||!selected||!id||!digest||!expiry||Date.now()>=Date.parse(expiry))return;
  return register({actionId:id,reviewedDigest:digest,expiresAt:expiry,confirm:()=>call.current()});
 },[register,id,digest,expiry,selected]);
 return batch;
}

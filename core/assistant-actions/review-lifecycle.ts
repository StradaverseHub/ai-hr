/** Shared held-row transaction state owner. Call after exact actor/subject/row binding.
 * A completed or retired row never reaches pending work, and a wrong pending confirmation digest
 * never reaches native source work. Callbacks remain in the caller's original top-level Tx. */
export type ReviewLifecycleState='awaiting_confirmation'|'completed'|'discarded'|'expired'|'refused';
export async function settleReviewCustodyTx<R extends {metadata:{state:ReviewLifecycleState;reviewedDigest:string|null}},P,C,T>(
 row:R,operation:{kind:'reopen'}|{kind:'confirm';expectedDigest:string},
 owner:{pending(row:R):Promise<P>;completed(row:R):Promise<C>;retired(row:R):T;unavailable():never},
):Promise<P|C|T>{
 if(row.metadata.state==='completed')return owner.completed(row);
 if(row.metadata.state!=='awaiting_confirmation')return owner.retired(row);
 if(operation.kind==='confirm'&&row.metadata.reviewedDigest!==operation.expectedDigest)return owner.unavailable();
 return owner.pending(row);
}

/** AI v2 W2 (slice 2) — read-only: what the roster holds for one date of the caller's own employment, as the Leave Credit
 * request form fills its day type (app/leave/credit/actions.ts leaveCreditDayFactsAction reads the same owner). For the
 * chat preparer (core/proposals/toil-request.ts), which imports no leave write path. RLS-scoped as the caller; NOT the
 * control: the leave service adjudicates the day type again at preparation, at submission and at approval. */
import type {SessionContext} from '../../db/client';
import {workedDayKindForEmployment} from '../../packs/leave/service';

export function ownWorkedDayKind(ctx:SessionContext,employmentId:string,date:string){
 return workedDayKindForEmployment({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))},employmentId,date);
}

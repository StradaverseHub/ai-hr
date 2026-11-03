/** AI v2 Phase 2, P2-6 — who may read and decide on the learning loops: HR and group administrators under their own login,
 * never an agent principal. The page's guard; every service checks it again, and the 0972 policies narrow each row to the
 * companies the administrator administers (app.is_admin_for). */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';

export class LearningRefused extends Error{
 constructor(readonly reason:'not_administrator'|'invalid'|'not_found'|'changed'|'not_redacted'|'state'){super('Learning loop refused: '+reason);this.name='LearningRefused';}
}
export const requireLearningAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LearningRefused('not_administrator');};
/** The session as it was when the request arrived: later awaits cannot change whose roles a service checks. */
export const captureCtx=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

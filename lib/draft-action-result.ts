/** Client-safe action outcomes. Type-only owner imports are erased; no core runtime reaches the client. */
import type {DraftActivationProblem} from '../core/employee-draft';
export type DraftDeleteActionResult = {ok:true} | {ok:false;kind:'system';reference:string};
export type DraftActivateActionResult = {ok:true;employmentId:string}
  | ({ok:false;kind:'validation'} & DraftActivationProblem)
  | {ok:false;kind:'system';reference:string};

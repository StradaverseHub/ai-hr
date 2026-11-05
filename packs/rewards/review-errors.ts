import {isDatabaseError,pgSqlState} from '../../lib/db-error';

/** Award and advisor operations can bind compensation and raw attachments. Never include them in URLs or logs. */
export function rewardReviewPublicError(error:unknown):string{
 if(isDatabaseError(error)){
  if(pgSqlState(error)==='42501')return 'Your current Rewards permissions do not allow this change.';
  return 'The Rewards change could not be saved. Reload the review and check the current stage and source data.';
 }
 return error instanceof Error?error.message:'The Rewards change could not be completed.';
}

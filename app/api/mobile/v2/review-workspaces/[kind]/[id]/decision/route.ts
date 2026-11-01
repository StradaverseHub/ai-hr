import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileInput} from '@/lib/mobile-api/body';
import {reviewWorkspaceOf} from '@/lib/mobile-api/review-workspace-routes';
import {ReviewWorkspaceCommand,ReviewWorkspaceDecisionResult} from '@/lib/mobile-api/v2/review-workspaces';
import {decideReviewWorkspace} from '@/core/mobile-review-workspaces';
export const POST=mobileRoute(ReviewWorkspaceDecisionResult,async(ctx,req)=>{const {kind,id}=reviewWorkspaceOf(req),c=ReviewWorkspaceCommand.safeParse(await mobileInput(req));if(!c.success)throw new MobileBadRequest('Invalid review command');return decideReviewWorkspace(ctx,kind,id,c.data);});

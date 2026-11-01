import {mobileRoute} from '@/lib/mobile-api/handler';
import {reviewWorkspaceOf} from '@/lib/mobile-api/review-workspace-routes';
import {ReviewWorkspaceResult} from '@/lib/mobile-api/v2/review-workspaces';
import {readReviewWorkspace} from '@/core/mobile-review-workspaces';
export const GET = mobileRoute(ReviewWorkspaceResult,async(ctx,req)=>{const {kind,id}=reviewWorkspaceOf(req);return readReviewWorkspace(ctx,kind,id);});

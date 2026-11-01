import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileInput} from '@/lib/mobile-api/body';
import {requestWorkspaceOf} from '@/lib/mobile-api/request-workspace-routes';
import {profileLabels} from '@/lib/mobile-api/profile-routes';
import {RequestWorkspaceCommand,RequestWorkspaceDecisionResult} from '@/lib/mobile-api/v2/request-workspaces';
import {decideRequestWorkspace} from '@/core/mobile-request-workspaces';
export const POST = mobileRoute(RequestWorkspaceDecisionResult,async(ctx,req)=>{const {kind,id}=requestWorkspaceOf(req),c=RequestWorkspaceCommand.safeParse(await mobileInput(req));if(!c.success)throw new MobileBadRequest('Invalid request command');return decideRequestWorkspace(ctx,kind,id,c.data,await profileLabels(req));});

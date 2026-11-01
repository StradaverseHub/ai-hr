import {mobileRoute} from '@/lib/mobile-api/handler';
import {requestWorkspaceOf} from '@/lib/mobile-api/request-workspace-routes';
import {profileLabels} from '@/lib/mobile-api/profile-routes';
import {RequestWorkspaceResult} from '@/lib/mobile-api/v2/request-workspaces';
import {readRequestWorkspace} from '@/core/mobile-request-workspaces';
export const GET = mobileRoute(RequestWorkspaceResult,async(ctx,req)=>{const {kind,id}=requestWorkspaceOf(req);return readRequestWorkspace(ctx,kind,id,await profileLabels(req));});

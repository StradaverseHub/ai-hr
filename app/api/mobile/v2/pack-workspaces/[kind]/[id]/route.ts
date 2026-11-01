import {mobileRoute} from '@/lib/mobile-api/handler';
import {packWorkspaceOf} from '@/lib/mobile-api/pack-workspace-routes';
import {PackWorkspaceResult} from '@/lib/mobile-api/v2/pack-workspaces';
import {readPackWorkspace} from '@/core/mobile-pack-workspaces';
export const GET=mobileRoute(PackWorkspaceResult,async(ctx,req)=>{const {kind,id}=packWorkspaceOf(req);return readPackWorkspace(ctx,kind,id);});

import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {mobileInput} from '@/lib/mobile-api/body';
import {packWorkspaceOf} from '@/lib/mobile-api/pack-workspace-routes';
import {PackWorkspaceCommand,PackWorkspaceDecisionResult} from '@/lib/mobile-api/v2/pack-workspaces';
import {decidePackWorkspace} from '@/core/mobile-pack-workspaces';
export const POST=mobileRoute(PackWorkspaceDecisionResult,async(ctx,req)=>{const {kind,id}=packWorkspaceOf(req),c=PackWorkspaceCommand.safeParse(await mobileInput(req,2*1024*1024));if(!c.success)throw new MobileBadRequest('Invalid review command');return decidePackWorkspace(ctx,kind,id,c.data);});

import {z} from 'zod';
import {mobileRoute,MobileBadRequest} from '@/lib/mobile-api/handler';
import {packWorkspaceOf} from '@/lib/mobile-api/pack-workspace-routes';
import {PackWorkspaceResult} from '@/lib/mobile-api/v2/pack-workspaces';
import {readPackWorkspace} from '@/core/mobile-pack-workspaces';
export const GET = mobileRoute(PackWorkspaceResult,async(ctx,req)=>{const {kind,id}=packWorkspaceOf(req);const q=new URL(req.url).searchParams,focus=q.get('focus'),offset=Number(q.get('offset')??0);if(focus&&!z.uuid().safeParse(focus).success||!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new MobileBadRequest('Invalid review navigation');return readPackWorkspace(ctx,kind,id,{focus:focus??undefined,offset});});

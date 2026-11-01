import {z} from 'zod';
import {mobileBinaryRoute,MobileBadRequest,MOBILE_ATTACHMENT_TYPES} from '@/lib/mobile-api/handler';
import {packWorkspaceOf} from '@/lib/mobile-api/pack-workspace-routes';
import {TaskDocumentRefusal} from '@/lib/mobile-api/v2/request-workspaces';
import {packWorkspaceDocument} from '@/core/mobile-pack-workspaces';
export const GET=mobileBinaryRoute(TaskDocumentRefusal,async(ctx,req)=>{const {kind,id}=packWorkspaceOf(req),ref=z.uuid().safeParse(new URL(req.url).searchParams.get('attachment'));if(!ref.success)throw new MobileBadRequest('Invalid attachment');return packWorkspaceDocument(ctx,kind,id,ref.data);},{types:MOBILE_ATTACHMENT_TYPES});

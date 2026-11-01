import {mobileBinaryRoute,MobileBadRequest,MOBILE_ATTACHMENT_TYPES} from '@/lib/mobile-api/handler';
import {requestWorkspaceOf} from '@/lib/mobile-api/request-workspace-routes';
import {profileLabels} from '@/lib/mobile-api/profile-routes';
import {TaskDocumentRefusal} from '@/lib/mobile-api/v2/request-workspaces';
import {requestWorkspaceDocument} from '@/core/mobile-request-workspaces';
export const GET = mobileBinaryRoute(TaskDocumentRefusal,async(ctx,req)=>{const {kind,id}=requestWorkspaceOf(req),ref=new URL(req.url).searchParams.get('attachment');if(!ref||ref.length>128)throw new MobileBadRequest('Invalid attachment');return requestWorkspaceDocument(ctx,kind,id,ref,await profileLabels(req));},{types:MOBILE_ATTACHMENT_TYPES});

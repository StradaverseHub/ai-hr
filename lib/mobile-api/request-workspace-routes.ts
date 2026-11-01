import {MobileBadRequest} from './handler';
import {RequestWorkspaceKind,validRequestReference} from './v2/request-workspaces';
export function requestWorkspaceOf(req:Request){const parts=new URL(req.url).pathname.split('/'),at=parts.indexOf('request-workspaces'),kind=RequestWorkspaceKind.safeParse(parts[at+1]),id=parts[at+2]??'';if(at<0||!kind.success||!validRequestReference(kind.data,id))throw new MobileBadRequest('Invalid workspace reference');return {kind:kind.data,id:id.toLowerCase()};}

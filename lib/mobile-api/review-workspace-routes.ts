import {MobileBadRequest} from './handler';
import {ReviewWorkspaceKind} from './v2/review-workspaces';
export function reviewWorkspaceOf(req:Request){const parts=new URL(req.url).pathname.split('/'),at=parts.indexOf('review-workspaces'),kind=ReviewWorkspaceKind.safeParse(parts[at+1]),id=parts[at+2]??'';if(at<0||!kind.success||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new MobileBadRequest('Invalid review reference');return {kind:kind.data,id:id.toLowerCase()};}

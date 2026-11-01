import {z} from 'zod';
import {MobileBadRequest} from './handler';
import {PackWorkspaceKind} from './v2/pack-workspaces';
export function packWorkspaceOf(req:Request){const parts=new URL(req.url).pathname.split('/'),at=parts.indexOf('pack-workspaces'),kind=PackWorkspaceKind.safeParse(parts[at+1]),id=z.uuid().safeParse(parts[at+2]);if(at<0||!kind.success||!id.success)throw new MobileBadRequest('Invalid workspace reference');return {kind:kind.data,id:id.data.toLowerCase()};}

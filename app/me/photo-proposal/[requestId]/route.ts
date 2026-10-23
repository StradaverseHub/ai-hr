import {z} from 'zod';
import {getSession} from '@/lib/session';
import {getProfilePhotoProposal} from '@/core/person-photo';
/** Every read rechecks request RLS and current privacy. Pending personal bytes are never cached. */
export async function GET(_request:Request,{params}:{params:Promise<{requestId:string}>}){
 const {requestId}=await params;if(!z.uuid().safeParse(requestId).success)return new Response('Not found',{status:404});
 const photo=await getProfilePhotoProposal(await getSession(),requestId);
 if(!photo)return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});
 return new Response(new Uint8Array(photo.content),{headers:{'Content-Type':photo.mimeType,'Content-Length':String(photo.content.byteLength),'Content-Disposition':'inline; filename="proposed-profile-photo"','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
}

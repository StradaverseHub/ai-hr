import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {db} from '@/db/client';
export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}){
 const {token}=await params;if(!z.string().regex(/^[a-f0-9]{64}$/).safeParse(token).success)return new Response(null,{status:404});
 const [row]=await db.execute<{mime:string;bytes:Buffer}>(sql`select * from app.email_asset_read(${token})`);
 if(!row)return new Response(null,{status:404});
 return new Response(new Uint8Array(row.bytes),{headers:{'content-type':row.mime,'cache-control':'public,max-age=31536000,immutable','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
}

/** Stream bounds apply before parsing; a forged Content-Length cannot allocate an unbounded upload. */
import { MobileBadRequest } from './handler';
import { readBoundedBody } from '../bounded-body';
export async function mobileBody(req: Request, limit: number): Promise<Response> {
  try {
    const bytes = await readBoundedBody(req, limit, 30_000, req.signal);
    return new Response(Buffer.from(bytes),{headers:{'content-type':req.headers.get('content-type')??''}});
  } catch { throw new MobileBadRequest('Invalid body'); }
}
export async function mobileForm(req:Request,keys:readonly string[],limit:number):Promise<FormData>{
  if(!req.headers.get('content-type')?.startsWith('multipart/form-data')) throw new MobileBadRequest('Multipart required');
  let data:FormData;
  try{data=await(await mobileBody(req,limit)).formData();}catch{throw new MobileBadRequest('Invalid form');}
  for(const key of data.keys()) if(!keys.includes(key)||data.getAll(key).length!==1) throw new MobileBadRequest('Invalid fields');
  return data;
}
export async function mobileInput(req:Request,limit=16384):Promise<unknown>{
  if(!req.headers.get('content-type')?.startsWith('application/json'))throw new MobileBadRequest('JSON required');
  try{return await(await mobileBody(req,limit)).json();}catch{throw new MobileBadRequest('Invalid JSON');}
}

/** Stream bounds apply before parsing; a forged Content-Length cannot allocate an unbounded upload. */
import { MobileBadRequest } from './handler';
export async function mobileBody(req: Request, limit: number): Promise<Response> {
  const reader=req.body?.getReader();
  if(!reader) throw new MobileBadRequest('Body required');
  const chunks:Uint8Array[]=[]; let size=0;
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel();throw new MobileBadRequest('Body too large');}chunks.push(next.value);}
  return new Response(Buffer.concat(chunks.map(c=>Buffer.from(c))),{headers:{'content-type':req.headers.get('content-type')??''}});
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

/** One bounded POST, no automatic effect retry. Deadline spans fetch AND response body. */
import {PeopleGeneralPolicyPacket,parsePeopleGeneralPolicyResult} from '@/lib/assistant-actions/people-general-policy-http';
export async function sendPeopleGeneralPolicy(value:unknown,signal:AbortSignal){
 const packet=PeopleGeneralPolicyPacket.parse(structuredClone(value)),controller=new AbortController();let rejectStop!:()=>void;
 const stopped=new Promise<never>((_,reject)=>{rejectStop=()=>reject(Error('Policy response unavailable.'));});void stopped.catch(()=>{});
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const stop=()=>{controller.abort();rejectStop();void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();const timer=setTimeout(stop,15000);
 try{
  const response=await Promise.race([fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)}),stopped]);
  if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body){void response.body?.cancel().catch(()=>{});throw Error();}
  reader=response.body.getReader();const parts:Uint8Array[]=[];let bytes=0,fragments=0;
  for(;;){const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(++fragments>512||(bytes+=part.value.byteLength)>32768)throw Error();parts.push(part.value);}
  const data=new Uint8Array(bytes);let offset=0;for(const p of parts){data.set(p,offset);offset+=p.byteLength;}
  if(controller.signal.aborted)throw Error();return parsePeopleGeneralPolicyResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
 }catch{void reader?.cancel().catch(()=>{});throw Error('Policy response unavailable.');}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);reader?.releaseLock();}
}

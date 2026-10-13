import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { AiImageReadError,readImage,supportsImageReading,type AiProvider } from '../lib/ai';
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8R0AAAAASUVORK5CYII=','base64'));
const providers:AiProvider[]=['openai','anthropic','google'];
let transport:ReturnType<typeof vi.fn>;
beforeEach(()=>{transport=vi.fn();vi.stubGlobal('fetch',transport);});
afterEach(()=>vi.unstubAllGlobals());
function response(provider:AiProvider,text:string){return provider==='openai'?{id:'fixture',choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}:provider==='anthropic'?{id:'fixture',type:'message',role:'assistant',content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}:{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]};}
const body=(input:RequestInfo|URL,init?:RequestInit)=>init?.body?JSON.parse(String(init.body)):input instanceof Request?input.clone().json():null;
describe('shared image-reading gateway with real provider transports',()=>{
 for(const provider of providers){
  it(`${provider} sends only image bytes and the fixed transcription instruction through its adapter`,async()=>{
   let request:unknown;transport.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{request=await body(input,init);return new Response(JSON.stringify(response(provider,'Verified 15.9 units.')),{status:200,headers:{'content-type':'application/json'}});});
   expect(supportsImageReading(provider)).toBe(true);expect(await readImage({provider,model:'fixture',apiKey:'fixture-local-only'},{data:png,mimeType:'image/png'})).toBe('Verified 15.9 units.');expect(transport).toHaveBeenCalledOnce();
   const encoded=JSON.stringify(request);expect(encoded).toContain(Buffer.from(png).toString('base64'));expect(encoded).toContain('Transcribe the visible text');expect(encoded).not.toContain('fixture-local-only');
  });
  it(`${provider} cancels the real SDK transport at the deadline without hidden retries`,async()=>{
   let aborted=false;transport.mockImplementation((input:RequestInfo|URL,init?:RequestInit)=>new Promise((_resolve,reject)=>{const signal=init?.signal??(input instanceof Request?input.signal:null);if(!signal)throw Error('The adapter did not pass cancellation to fetch.');const abort=()=>{aborted=true;reject(new DOMException('fixture aborted','AbortError'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});}));
   const start=Date.now();await expect(readImage({provider,model:'fixture',apiKey:'fixture-local-only'},{data:png,mimeType:'image/png',timeoutMs:30})).rejects.toMatchObject({name:'AiImageReadError',retryable:true});expect(aborted).toBe(true);expect(transport).toHaveBeenCalledOnce();expect(Date.now()-start).toBeLessThan(1500);
  });
  it(`${provider} maps permanent and transient failures without exposing provider bodies`,async()=>{
   for(const [status,retryable] of [[400,false],[413,false],[415,false],[401,true],[429,true],[503,true]] as const){
    transport.mockReset().mockResolvedValue(new Response(JSON.stringify({error:{code:status,message:'secret-provider-body fixture-local-only',status:'INVALID_ARGUMENT'}}),{status,headers:{'content-type':'application/json'}}));
    const error=await readImage({provider,model:'fixture',apiKey:'fixture-local-only'},{data:png,mimeType:'image/png'}).catch(error=>error);
    expect(error).toBeInstanceOf(AiImageReadError);expect(error.retryable).toBe(retryable);expect(error.message).not.toContain('secret-provider-body');expect(error.message).not.toContain('fixture-local-only');expect(error.cause).toBeUndefined();expect(transport).toHaveBeenCalledOnce();
   }
  });
 }
 it('rejects wrong MIME signatures, large content, arbitrary URL payloads and an already-cancelled request before transmission',async()=>{
  const cfg={provider:'openai' as const,model:'fixture',apiKey:'fixture-local-only'};
  for(const args of [{data:png,mimeType:'image/jpeg'},{data:new Uint8Array(2*1024*1024+1),mimeType:'image/png'},{data:'https://elsewhere.invalid/private',mimeType:'image/png'}])await expect(readImage(cfg,args as Parameters<typeof readImage>[1])).rejects.toMatchObject({retryable:false});
  await expect(readImage(cfg,{data:png,mimeType:'image/png',signal:AbortSignal.abort()})).rejects.toMatchObject({retryable:true});expect(transport).not.toHaveBeenCalled();
 });
 it('bounds transcription length and treats empty readable text as a valid empty result',async()=>{
  const cfg={provider:'openai' as const,model:'fixture',apiKey:'fixture-local-only'};transport.mockResolvedValue(new Response(JSON.stringify(response('openai','🙂'.repeat(7000))),{headers:{'content-type':'application/json'}}));expect(Array.from(await readImage(cfg,{data:png,mimeType:'image/png'}))).toHaveLength(6000);
  transport.mockResolvedValue(new Response(JSON.stringify(response('openai','')),{headers:{'content-type':'application/json'}}));expect(await readImage(cfg,{data:png,mimeType:'image/png'})).toBe('');
 });
});

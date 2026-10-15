import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { AiImageReadError,readImage,generateDraft,supportsImageReading,type AiProvider,type ResolvedAiConfig } from '../lib/ai';
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8R0AAAAASUVORK5CYII=','base64'));
const providers:AiProvider[]=['openai','anthropic','google'];
let transport:ReturnType<typeof vi.fn>;
beforeEach(()=>{transport=vi.fn();vi.stubGlobal('fetch',transport);});
afterEach(()=>vi.unstubAllGlobals());
function response(provider:AiProvider,text:string){return provider==='openai'?{id:'fixture',choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}:provider==='anthropic'?{id:'fixture',type:'message',role:'assistant',content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}:{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]};}
const body=(input:RequestInfo|URL,init?:RequestInit)=>init?.body?JSON.parse(String(init.body)):input instanceof Request?input.clone().json():null;
describe('shared image-reading gateway with real provider transports',()=>{
 for(const provider of providers){
  it(`${provider} bounds an explicit text assessment without changing the prompt or retrying a failed request`,async()=>{
   let request:unknown;transport.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{request=await body(input,init);return new Response(JSON.stringify(response(provider,'A grounded assessment.')),{status:200,headers:{'content-type':'application/json'}});});
   const cfg={provider,model:'fixture',apiKey:'fixture-local-only'};expect(await generateDraft(cfg,{system:'Assess supplied facts.',prompt:'Authorized case.',timeoutMs:2000})).toBe('A grounded assessment.');expect(JSON.stringify(request)).toContain('Authorized case.');expect(transport).toHaveBeenCalledOnce();
   transport.mockReset().mockResolvedValue(new Response(JSON.stringify({error:{message:'secret-provider-body'}}),{status:503,headers:{'content-type':'application/json'}}));await expect(generateDraft(cfg,{system:'Assess supplied facts.',prompt:'Authorized case.',timeoutMs:2000})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();
  });
  it(`${provider} propagates a bounded text deadline to the real transport`,async()=>{
   let aborted=false;transport.mockImplementation((input:RequestInfo|URL,init?:RequestInit)=>new Promise((_resolve,reject)=>{const signal=init?.signal??(input instanceof Request?input.signal:null);if(!signal)throw Error('Missing transport cancellation.');const abort=()=>{aborted=true;reject(new DOMException('fixture aborted','AbortError'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});}));
   await expect(generateDraft({provider,model:'fixture',apiKey:'fixture-local-only'},{system:'Assess supplied facts.',prompt:'Authorized case.',timeoutMs:30})).rejects.toThrow();expect(aborted).toBe(true);expect(transport).toHaveBeenCalledOnce();
  });
  it(`${provider} rejects a truncated assessment even when its partial content is valid JSON`,async()=>{
   const content=response(provider,'{"verdict":"well_justified"}');if('choices' in content&&content.choices)content.choices[0].finish_reason='length';else if('stop_reason' in content)content.stop_reason='max_tokens';else content.candidates[0].finishReason='MAX_TOKENS';
   transport.mockResolvedValue(new Response(JSON.stringify(content),{headers:{'content-type':'application/json'}}));await expect(generateDraft({provider,model:'fixture',apiKey:'fixture-local-only'},{system:'Assess supplied facts.',prompt:'Authorized case.',timeoutMs:1000})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();
  });
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

// Exercise the real gateway + SDK adapters: an adapter that forgets its observer must retain capacity,
// and missing counters must never become a reported zero in the central ledger.
describe('usage reporting across every real transport operation',()=>{
 for(const provider of providers)it(`${provider} distinguishes reported, zero, absent and malformed counters`,async()=>{
  const {converse}=await import('../lib/ai');
  const cases=['reported','zero','absent','malformed'] as const;
  for(const kind of cases){
   const observed:unknown[]=[];
   const cfg:ResolvedAiConfig={provider,model:'fixture',apiKey:'fixture-local-only',governance:{async run(_request,call){return call(value=>observed.push(value));}}};
   const result=response(provider,'A bounded answer.');
   const metadata=kind==='reported'?(provider==='openai'?{prompt_tokens:10,completion_tokens:3,prompt_tokens_details:{cached_tokens:4}}:provider==='anthropic'?{input_tokens:10,output_tokens:3,cache_read_input_tokens:4}:{promptTokenCount:10,candidatesTokenCount:3,cachedContentTokenCount:4}):kind==='zero'?(provider==='openai'?{prompt_tokens:0,completion_tokens:0}:provider==='anthropic'?{input_tokens:0,output_tokens:0}:{promptTokenCount:0,candidatesTokenCount:0}):kind==='malformed'?{}:undefined;
   const payload={...result,...(provider==='google'?{usageMetadata:metadata}:{usage:metadata})};
   transport.mockReset().mockImplementation(()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}}));
   await generateDraft(cfg,{system:'Only supplied facts.',prompt:'Fictional facts.',timeoutMs:1000});
   await readImage(cfg,{data:png,mimeType:'image/png'});
   await converse(cfg,{system:['Only supplied facts.'],turns:[{role:'user',content:'Fictional facts.'}],tools:[]});
   const expected=kind==='reported'?{inputTokens:provider==='anthropic'?10:6,outputTokens:3,cachedInputTokens:4}:{inputTokens:0,outputTokens:0,cachedInputTokens:0};
   expect(observed,kind).toEqual(kind==='absent'||kind==='malformed'?[]:[expected,expected,expected]);
   expect(transport).toHaveBeenCalledTimes(3);
  }
 });
});


describe('governed requests do not hide provider retry loops',()=>{
 for(const provider of providers)it(`${provider} attempts each governed operation only once`,async()=>{
  const {converse}=await import('../lib/ai');
  const cfg:ResolvedAiConfig={provider,model:'fixture',apiKey:'fixture-local-only',governance:{async run(_request,call){return call(()=>{});}}};
  for(const operation of [()=>generateDraft(cfg,{system:'Only supplied facts.',prompt:'Fictional facts.'}),()=>readImage(cfg,{data:png,mimeType:'image/png'}),()=>converse(cfg,{system:['Only supplied facts.'],turns:[{role:'user',content:'Fictional facts.'}],tools:[]})]){
   transport.mockReset().mockImplementation(()=>new Response(JSON.stringify({error:{code:503,status:'UNAVAILABLE',message:'fixture failure'}}),{status:503,headers:{'content-type':'application/json'}}));
   await expect(operation()).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(1);
  }
 });
});

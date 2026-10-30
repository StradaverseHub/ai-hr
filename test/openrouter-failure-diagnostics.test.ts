import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Synthetic transport only. Diagnostics may contain three closed fields, never provider bodies,
 * credentials, prompts or exception text. No network, hosted-provider or HR-record claim. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AiGatewayError,type ConverseArgs} from '../lib/ai/types';
const privateKey='fixture-private-key-never-use',privatePrompt='fixture-private-prompt',privateBody='fixture-private-provider-body';
const config=()=>({model:'fictional/diagnostics',apiKey:privateKey,routing:{allowedProviders:['fixture-host'],allowFallbacks:false,sort:'latency'}});
const args=():ConverseArgs=>({system:['fixture-system'],turns:[{role:'user',content:privatePrompt}],tools:[]});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const ok=()=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:'fixture-answer'}}]});
const warning=()=>vi.spyOn(console,'warn').mockImplementation(()=>{});
function expectDiagnostic(spy:ReturnType<typeof warning>,phase:string,httpStatus:number|null){
 expect(spy.mock.calls).toEqual([['[ai-provider-transport-failure]',{provider:'openrouter',phase,httpStatus}]]);
 const serialized=JSON.stringify(spy.mock.calls);
 for(const value of [privateKey,privatePrompt,privateBody,'Authorization','https://','fictional/diagnostics'])expect(serialized).not.toContain(value);
}
async function failure(fetcher:typeof fetch,input:unknown=config(),request:ConverseArgs=args(),signal?:AbortSignal){
 const error=await createOpenRouterTransport(fetcher)(input,request,signal).catch(value=>value);
 expect(error).toBeInstanceOf(AiGatewayError);expect(error.message).toBe('AI provider response unavailable.');expect(error.cause).toBeUndefined();
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('closed OpenRouter failure diagnostics',()=>{
 it.each([400,401,402,403,404,429,500,503])('reports HTTP %i without reading or logging its private error body or retrying',async status=>{
  const spy=warning(),upstream=response({error:{message:privateBody,key:privateKey,prompt:privatePrompt}},status);
  const read=vi.spyOn(upstream.body!,'getReader'),fetcher=vi.fn<typeof fetch>().mockResolvedValue(upstream);
  await failure(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expectDiagnostic(spy,'response',status);
 });
 it.each([0,99,600,Infinity,NaN,401.5,privateBody])('never records an invalid or private status value (%s)',async status=>{
  const spy=warning(),upstream=response({error:privateBody,choices:[]});Object.defineProperty(upstream,'status',{value:status});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(upstream);await failure(fetcher);expectDiagnostic(spy,'completion',null);
 });
 it('separates network failure from an HTTP rejection without logging exception details',async()=>{
  const spy=warning(),fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error([privateKey,privatePrompt,privateBody].join(' ')));
  await failure(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);expectDiagnostic(spy,'network',null);
 });
 it('separates invalid configuration and request construction before any provider access',async()=>{
  const spy=warning(),fetcher=vi.fn<typeof fetch>();
  await failure(fetcher,{...config(),endpoint:privateBody});expectDiagnostic(spy,'configuration',null);spy.mockClear();
  await failure(fetcher,config(),{...args(),tools:[{name:'bad tool',description:privateBody,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}]});
  expectDiagnostic(spy,'request',null);expect(fetcher).not.toHaveBeenCalled();
 });
 it('distinguishes a rejected completion from a network or HTTP failure',async()=>{
  const spy=warning(),fetcher=vi.fn<typeof fetch>().mockResolvedValue(response({error:{message:privateBody},choices:[]}));
  await failure(fetcher);expectDiagnostic(spy,'completion',200);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('records cancellation without dispatching or exposing the abort reason',async()=>{
  const spy=warning(),fetcher=vi.fn<typeof fetch>(),controller=new AbortController();controller.abort(new Error(privateKey));
  await failure(fetcher,config(),args(),controller.signal);expectDiagnostic(spy,'cancelled',null);expect(fetcher).not.toHaveBeenCalled();
 });
 it('records a deadline once even when the provider does not honor abort',async()=>{
  vi.useFakeTimers();const spy=warning(),fetcher=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(()=>{}));
  const pending=failure(fetcher,config(),{...args(),timeoutMs:5});await vi.advanceTimersByTimeAsync(5);await pending;
  expectDiagnostic(spy,'cancelled',null);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('emits no failure diagnostic for a successful completion',async()=>{
  const spy=warning(),fetcher=vi.fn<typeof fetch>().mockResolvedValue(response(ok()));
  await expect(createOpenRouterTransport(fetcher)(config(),args())).resolves.toMatchObject({completion:{text:'fixture-answer'}});expect(spy).not.toHaveBeenCalled();
 });
 it('retains the generic provider failure if the diagnostic sink itself throws',async()=>{
  vi.spyOn(console,'warn').mockImplementation(()=>{throw new Error(privateKey);});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response({error:privateBody},400));await failure(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
 });
});

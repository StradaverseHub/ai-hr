import {afterEach,describe,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({start:vi.fn(),native:vi.fn(),exchange:vi.fn(),rate:vi.fn(),audit:vi.fn()}));
vi.mock('../db/client',()=>({client:{unsafe:mocks.audit}}));
vi.mock('../lib/internal-auth/config',()=>({internalConfig:()=>({origin:'https://hr.test'}),internalSelected:()=>true,internalReady:()=>true,INTERNAL_SESSION_COOKIE:'__Host-aihr_internal'}));
vi.mock('../lib/internal-auth/service',()=>({takeRate:mocks.rate}));
vi.mock('../lib/entra/login',()=>({ENTRA_FLOW_COOKIE:'__Host-aihr_entra',startEntraLogin:mocks.start,nativeLaunch:mocks.native,exchangeNative:mocks.exchange,completeEntraLogin:vi.fn()}));
import {GET,POST} from '../app/login/entra/[operation]/route';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
const get=(operation='start')=>GET(new NextRequest('https://hr.test/login/entra/'+operation+'?organization=acme'),{params:Promise.resolve({operation})});
describe('Entra HTTP admission and origin boundary',()=>{
 it('bounds outstanding discovery requests and releases all admitted slots',async()=>{
  const pending:Array<(value:{url:string;handle:string})=>void>=[];
  mocks.start.mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));mocks.rate.mockResolvedValue(undefined);
  const accepted=Array.from({length:8},()=>get());await vi.waitFor(()=>expect(mocks.start).toHaveBeenCalledTimes(8));
  const refused=await get();expect(refused.status).toBe(429);expect(refused.headers.get('retry-after')).toBe('1');expect(mocks.audit).not.toHaveBeenCalled();
  pending.forEach(resolve=>resolve({url:'https://login.microsoftonline.com/authorize',handle:'h'.repeat(43)}));
  expect((await Promise.all(accepted)).every(response=>response.status===303)).toBe(true);expect((await get('missing')).status).toBe(404);
 });
 it('does not start a native login from a foreign browser origin',async()=>{
  const response=await POST(new NextRequest('https://hr.test/login/entra/native',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json','x-aihr-client':'native'},body:'{}'}),{params:Promise.resolve({operation:'native'})});
  expect(response.status).toBe(403);expect(mocks.native).not.toHaveBeenCalled();expect(mocks.rate).not.toHaveBeenCalled();
 });
 it('returns a retryable refusal without erasing an active flow when the durable budget is spent',async()=>{
  mocks.rate.mockRejectedValueOnce({code:'rateLimited'});const response=await get();expect(response.status).toBe(429);expect(response.cookies.get('__Host-aihr_entra')).toBeUndefined();
 });
});

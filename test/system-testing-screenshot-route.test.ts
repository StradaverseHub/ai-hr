/** Real bounded HTTP reader and origin boundary; canonical storage/security covered separately. UNRUN. */
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { TestingRefusal,TESTING_LIMITS } from '../lib/system-testing/model';
const m=vi.hoisted(()=>({session:vi.fn(),add:vi.fn(),module:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../core/system-testing',()=>({addTestingScreenshot:m.add}));
vi.mock('../core/entitlements',()=>({assertModuleEnabled:m.module,ModuleNotEnabledError:class ModuleNotEnabledError extends Error{}}));
import { POST } from '../app/(app)/system-testing/executions/[id]/attachments/route';
const id='47335504-b4ad-401b-8d10-59499482ee22',runId='0a576e11-b48e-4b89-94f3-b8430ccf426b',ctx={tenantId:id,userId:runId,roles:['employee']};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
const url=`http://localhost:3214/system-testing/executions/${id}/attachments?runId=${runId}`;
const headers={origin:'http://localhost:3214',host:'localhost:3214','content-type':'image/png','x-file-name':encodeURIComponent('Fictional screenshot.png')};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(ctx);m.add.mockResolvedValue({id:runId});});
describe('testing screenshot request boundary',()=>{
  it('requires the actual browser origin before reading a session or invoking a writer',async()=>{
    const response=await POST(new Request(url,{method:'POST',headers:{...headers,origin:'https://other.invalid'},body:png}),{params:Promise.resolve({id})});
    expect(response.status).toBe(403);expect(m.session).not.toHaveBeenCalled();expect(m.add).not.toHaveBeenCalled();
  });
  it('binds the bounded file to server principal and exact execution/observation, not arbitrary caller identity',async()=>{
    const response=await POST(new Request(url+'&testerUserId=forged',{method:'POST',headers,body:png}),{params:Promise.resolve({id})});
    expect(response.status).toBe(201);expect(m.module).toHaveBeenCalledWith(ctx,'system_testing');
    expect(m.add).toHaveBeenCalledWith(ctx,{executionId:id,runId,fileName:'Fictional screenshot.png',mimeType:'image/png',content:Buffer.from(png)});
  });
  it('cancels an oversized chunked stream even without a Content-Length and never calls storage',async()=>{
    const cancelled=vi.fn();const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(TESTING_LIMITS.screenshotBytes+1));},cancel:cancelled});
    const init=Object.assign({method:'POST',headers,body:stream},{duplex:'half'});
    const response=await POST(new Request(url,init),{params:Promise.resolve({id})});
    expect(response.status).toBe(413);expect(cancelled).toHaveBeenCalledOnce();expect(m.add).not.toHaveBeenCalled();
  });
  it('returns only finite known refusals and propagates unknown database failures',async()=>{
    m.add.mockRejectedValue(new TestingRefusal('not_found'));
    const refused=await POST(new Request(url,{method:'POST',headers,body:png}),{params:Promise.resolve({id})});
    expect(refused.status).toBe(409);expect(await refused.json()).toEqual({error:'not_found'});
    const unknown=new Error('private SQL');m.add.mockRejectedValue(unknown);await expect(POST(new Request(url,{method:'POST',headers,body:png}),{params:Promise.resolve({id})})).rejects.toBe(unknown);
  });
});

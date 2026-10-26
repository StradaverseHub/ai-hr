/** Authored protocol/CSRF/privacy regressions. UNRUN; no real session/database/provider. */
import { describe, expect, it, vi } from 'vitest';
import { createOwnLeaveBrowserHandler } from '../lib/assistant-actions/own-leave-http';
const actionId = '11111111-1111-4111-8111-111111111111', employmentId = '22222222-2222-4222-8222-222222222222';
const leaveTypeId = '33333333-3333-4333-8333-333333333333', requestId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555', digest = 'a'.repeat(64);
const confirmation = { actionId, contractVersion: 1, reviewedDigest: digest };
const completed = { kind: 'completed', receipt: { actionId, contractVersion: 1, state: 'completed', leaveRequestId: requestId, submissionEventId: eventId } };
const prepare = { operation: 'prepare', nomination: { action: 'leave.apply', contractVersion: 1, employmentId, leaveTypeId, date: '2030-06-10', durationType: 'full_day' },
  selection: { employmentId, leaveTypeId }, humanText: { reason: 'Human entered reason', employeeRemark: 'Human entered remark' } };
const review = { kind: 'prepared', review: { actionId, contractVersion: 1, reviewedDigest: digest,
  createdAt: '2030-06-01T00:00:00.000Z', expiresAt: '2030-06-01T00:10:00.000Z', companyName: 'Fictional Company',
  employeeCode: null, leaveTypeName: 'Annual Leave', date: '2030-06-10', durationType: 'full_day', deductionDays: 1,
  availableBalance: null, estimatedAvailableAfter: null, holidayWarnings: [], approvalRouting: 'unknown', humanText: prepare.humanText } };
const session = Object.freeze({ login: 'server-session-only' });
function fixture() {
  const owners = { authenticate: vi.fn(async () => session), prepare: vi.fn(async () => review),
    reopen: vi.fn(async () => completed), confirm: vi.fn(async () => completed),
    discard: vi.fn(async () => ({ kind: 'retired', receipt: { actionId, contractVersion: 1, state: 'discarded' } })) };
  return { owners, run: createOwnLeaveBrowserHandler(owners) };
}
function request(body: unknown, headers: Record<string,string> = {}, url = 'https://hr.example/api/assistant/own-leave') {
  return new Request(url, { method: 'POST', headers: { origin: 'https://hr.example', host: 'hr.example',
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify(body) });
}
describe('own-leave browser transport owner', () => {
  it.each(['GET', 'HEAD', 'DELETE'])('refuses %s before identity or command work', async method => {
    const f=fixture(), response=await f.run(new Request('https://hr.example/api/assistant/own-leave',{method}));
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST'); expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  const browserAuthorityCases: Record<string,string>[] = [{ origin: 'https://foreign.example' }, { origin: '' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { origin: 'https://foreign.example', 'x-forwarded-host': 'foreign.example' }, { host: 'hr.example,foreign.example' }];
  it.each(browserAuthorityCases)
  ('refuses foreign/missing/ambiguous browser authority %j before reading session', async headers => {
    const f=fixture(), response=await f.run(request({operation:'confirm',confirmation},headers));
    expect(response.status).toBe(403); expect(f.owners.authenticate).not.toHaveBeenCalled(); expect(f.owners.confirm).not.toHaveBeenCalled();
  });
  it('is cookie-browser-only and refuses bearer authorization before identity lookup', async () => {
    const f=fixture();
    const response=await f.run(request({operation:'confirm',confirmation},{authorization:'Bearer fictional-not-used'}));
    expect(response.status).toBe(403);expect(f.owners.authenticate).not.toHaveBeenCalled();expect(f.owners.confirm).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({error:'unavailable'});
  });
  it('refuses missing Origin rather than relying on a cookie or forwarded host', async () => {
    const f=fixture(), req=request({operation:'confirm',confirmation});req.headers.delete('origin');
    expect((await f.run(req)).status).toBe(403);expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  it('refuses query-string action IDs and form posts', async () => {
    const f=fixture();expect((await f.run(request({}, {},'https://hr.example/api/assistant/own-leave?actionId='+actionId))).status).toBe(403);
    expect((await f.run(request({}, {'content-type':'application/x-www-form-urlencoded'}))).status).toBe(415);
    expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  it('authenticates then calls exactly the confirmed owner with immutable-business-field contract only', async () => {
    const f=fixture(), response=await f.run(request({operation:'confirm',confirmation}));
    expect(response.status).toBe(200);expect(await response.json()).toEqual(completed);
    expect(f.owners.confirm).toHaveBeenCalledTimes(1);expect(f.owners.confirm).toHaveBeenCalledWith(session,confirmation);
    expect(f.owners.prepare).not.toHaveBeenCalled();expect(f.owners.reopen).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });
  it.each([{operation:'confirm',confirmation:{...confirmation,employmentId}}, {operation:'confirm',confirmation,reason:'replaced'},
    {operation:'confirm',confirmation,session:{tenantId:'posted'}}, {operation:'confirm',confirmation:{...confirmation,contractVersion:2}},
    {operation:'execute',confirmation}, {...prepare,nomination:{...prepare.nomination,reason:'model-private-text'}},
    {...prepare,selection:{...prepare.selection,companyId:'posted'}}, {...prepare,locale:'posted'}, {...prepare,provider:'posted'}])
  ('refuses unknown authority/business/protocol fields %j', async body => {
    const f=fixture();expect((await f.run(request(body))).status).toBe(400);expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  it('keeps human selection/text separate at preparation and returns only the public card', async () => {
    const f=fixture(), response=await f.run(request(prepare));expect(response.status).toBe(200);expect(await response.json()).toEqual(review);
    expect(f.owners.prepare).toHaveBeenCalledTimes(1);expect(f.owners.prepare).toHaveBeenCalledWith(session,prepare);expect(f.owners.confirm).not.toHaveBeenCalled();
  });
  it('reopen and discard dispatch separately and never execute a request', async () => {
    const f=fixture();expect((await f.run(request({operation:'reopen',actionId}))).status).toBe(200);
    expect(f.owners.reopen).toHaveBeenCalledTimes(1);expect(f.owners.reopen).toHaveBeenCalledWith(session,actionId);
    expect((await f.run(request({operation:'discard',confirmation}))).status).toBe(200);
    expect(f.owners.discard).toHaveBeenCalledTimes(1);expect(f.owners.discard).toHaveBeenCalledWith(session,confirmation);expect(f.owners.confirm).not.toHaveBeenCalled();
  });
  it('cannot turn authentication failure into a command, or raw owner failure into public evidence', async () => {
    const f=fixture();f.owners.authenticate.mockRejectedValueOnce(Error('private session body'));
    const denied=await f.run(request({operation:'confirm',confirmation}));expect(denied.status).toBe(401);expect(f.owners.confirm).not.toHaveBeenCalled();
    f.owners.confirm.mockRejectedValueOnce(Error('secret database parameters'));
    const failed=await f.run(request({operation:'confirm',confirmation}));expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({error:'unavailable'});expect(f.owners.confirm).toHaveBeenCalledTimes(1); // No automatic effect retry.
  });
  it('refuses accidental private fields in an owner response instead of serializing them', async () => {
    const f=fixture();f.owners.prepare.mockResolvedValueOnce({...review,review:{...review.review,privateAvailableBalance:10}} as typeof review);
    const response=await f.run(request(prepare));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
  });
  it('bounds declared/actual UTF8 body size and refuses malformed UTF8 before authentication', async () => {
    const f=fixture();expect((await f.run(request(prepare,{'content-length':'999999'}))).status).toBe(400);
    expect((await f.run(request({...prepare,humanText:{reason:'🧪'.repeat(6000)}}))).status).toBe(400);
    const req=request({});const malformed=new Request(req.url,{method:'POST',headers:req.headers,body:new Uint8Array([0xc3,0x28])});
    expect((await f.run(malformed)).status).toBe(400);expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  it('refuses a fragmented empty stream before it can consume unbounded reads', async () => {
    const f=fixture(), req=request({}), cancel=vi.fn();
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array());},cancel});
    const response=await f.run(new Request(req.url,{method:'POST',headers:req.headers,body:stream,duplex:'half'} as RequestInit));
    expect(response.status).toBe(400);expect(cancel).toHaveBeenCalled();expect(f.owners.authenticate).not.toHaveBeenCalled();
  });
  it('stops pre-cancelled and stalled body readers without admitting a session/effect', async () => {
    vi.useFakeTimers();
    try {
      const f=fixture(), controller=new AbortController();controller.abort();const req=request(prepare);
      expect((await f.run(new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(prepare),signal:controller.signal}))).status).toBe(400);
      const cancel=vi.fn(), stream=new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>{}),cancel});
      const pending=f.run(new Request(req.url,{method:'POST',headers:req.headers,body:stream,duplex:'half'} as RequestInit));
      await vi.advanceTimersByTimeAsync(5001);expect((await pending).status).toBe(400);expect(cancel).toHaveBeenCalled();
      expect(f.owners.authenticate).not.toHaveBeenCalled();expect(f.owners.confirm).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
});

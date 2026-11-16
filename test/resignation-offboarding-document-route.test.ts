/** The linked PDF route delegates to the exact offboarding read capability, with no generic reader fallback. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const fx=vi.hoisted(()=>({session:{tenantId:'tenant-a',userId:'operator-a'},direct:vi.fn(),linked:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:async()=>fx.session}));
vi.mock('@/packs/lifecycle/resignation/service',()=>({downloadResignationLetter:fx.direct,downloadResignationOffboardingLetter:fx.linked}));
import {GET} from '../app/resignation/[caseId]/documents/[documentId]/route';
const params=()=>({params:Promise.resolve({caseId:'journey-a',documentId:'document-a'})});
beforeEach(()=>{vi.clearAllMocks();fx.direct.mockResolvedValue({name:'Own letter.pdf',content:new Uint8Array([37,80,68,70])});fx.linked.mockResolvedValue({name:'Linked acceptance.pdf',content:new Uint8Array([37,80,68,70])});});
describe('released acceptance PDF from Offboarding',()=>{
 it('binds the authenticated operator, journey, document and offboarding case to the narrow reader',async()=>{
  const result=await GET(new Request('https://hr.example/resignation/journey-a/documents/document-a?offboardingCaseId=offboarding-a'),params());
  expect(fx.linked).toHaveBeenCalledWith(fx.session,{caseId:'journey-a',documentId:'document-a',offboardingCaseId:'offboarding-a'});expect(fx.direct).not.toHaveBeenCalled();expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');expect(result.headers.get('content-type')).toBe('application/pdf');expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([37,80,68,70]));
 });
 it('returns unavailable when the linked capability refuses, without retrying a broader journey read',async()=>{
  fx.linked.mockRejectedValue(Object.assign(Error('Released letter unavailable.'),{code:'not_found'}));const result=await GET(new Request('https://hr.example/resignation/journey-a/documents/document-a?offboardingCaseId=other-case'),params());expect(result.status).toBe(404);expect(fx.direct).not.toHaveBeenCalled();
 });
 it('preserves the existing journey reader when the request has no offboarding capability',async()=>{
  await GET(new Request('https://hr.example/resignation/journey-a/documents/document-a'),params());expect(fx.direct).toHaveBeenCalledWith(fx.session,{caseId:'journey-a',documentId:'document-a'});expect(fx.linked).not.toHaveBeenCalled();
 });
});

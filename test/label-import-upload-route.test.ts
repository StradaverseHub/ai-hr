import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LABEL_UPLOAD_REQUEST_MAX_BYTES} from '../lib/system-label-upload';
const calls=vi.hoisted(()=>({admin:vi.fn(async()=>({s:{}})),preview:vi.fn(),apply:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:calls.admin}));
vi.mock('../app/(app)/admin/settings/system-labels/import-actions',()=>({previewLabelsAction:calls.preview,importLabelsAction:calls.apply}));
import {POST} from '../app/(app)/admin/settings/system-labels/import/route';
beforeEach(()=>{vi.clearAllMocks();calls.preview.mockResolvedValue({ok:true,preview:{token:'t',rows:[],valid:false,mode:'add'}});calls.apply.mockResolvedValue({ok:true,summary:{imported:1,updated:0,skipped:0,failed:0}});});
const request=(operation:string,size=1)=>{const body=new FormData();body.set('operation',operation);body.set('file',new File([new Uint8Array(size)],'fictional.xls'));return new Request('http://localhost/admin/settings/system-labels/import',{method:'POST',headers:{Origin:'http://localhost'},body});};
describe('authenticated bounded Labels wizard transport',()=>{
 it('accepts the full allowed 5 MB workbook through the canonical preview action',async()=>{
  const response=await POST(request('preview',5_000_000));expect(response.status).toBe(200);expect(calls.preview).toHaveBeenCalledOnce();expect(calls.apply).not.toHaveBeenCalled();
  const file=(calls.preview.mock.calls[0] as unknown as [FormData])[0].get('file') as File;expect(file.size).toBe(5_000_000);expect(file.name).toBe('fictional.xls');expect(response.headers.get('Cache-Control')).toBe('private, no-store');
 });
 it('routes only the explicit apply operation to the canonical confirmation owner',async()=>{
  expect((await POST(request('apply'))).status).toBe(200);expect(calls.apply).toHaveBeenCalledOnce();expect(calls.preview).not.toHaveBeenCalled();
  expect((await POST(request('update'))).status).toBe(400);expect(calls.apply).toHaveBeenCalledOnce();
 });
 it('rejects cross-site requests before parsing or checking administrator scope',async()=>{
  const result=await POST(new Request('http://localhost/admin/settings/system-labels/import',{method:'POST',headers:{Origin:'http://other.invalid'},body:'x'}));expect(result.status).toBe(403);expect(calls.admin).not.toHaveBeenCalled();expect(calls.preview).not.toHaveBeenCalled();expect(calls.apply).not.toHaveBeenCalled();
 });
 it('bounds streamed multipart bytes before invoking preview or confirmation',async()=>{
  const result=await POST(new Request('http://localhost/admin/settings/system-labels/import',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'multipart/form-data; boundary=fixture'},body:'x'.repeat(LABEL_UPLOAD_REQUEST_MAX_BYTES+1)}));expect(result.status).toBe(413);expect(calls.preview).not.toHaveBeenCalled();expect(calls.apply).not.toHaveBeenCalled();
 });
 it('returns a truthful canonical refusal instead of a Done result',async()=>{
  calls.apply.mockResolvedValueOnce({ok:false,message:'Labels changed since preview.'});const result=await POST(request('apply'));expect(result.status).toBe(400);expect(await result.json()).toEqual({ok:false,message:'Labels changed since preview.'});
 });
});

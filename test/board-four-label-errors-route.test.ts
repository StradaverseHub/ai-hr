import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
const calls=vi.hoisted(()=>({admin:vi.fn(async()=>({s:{}})),preview:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:calls.admin}));
vi.mock('../app/(app)/admin/settings/system-labels/import-actions',()=>({previewLabelsAction:calls.preview}));
import { LABEL_UPLOAD_REQUEST_MAX_BYTES } from '../lib/system-label-upload';
import { POST } from '../app/(app)/admin/settings/system-labels/errors/route';
beforeEach(()=>{vi.clearAllMocks();calls.preview.mockResolvedValue({ok:true,preview:{rows:[{sheet:'division',row:2,outcome:'error',message:'Code is required.',values:{Code:''}}]}});});
describe('authenticated label error download',()=>{
  it('returns a real safe Excel attachment using the current validated preview',async()=>{
    const data=new FormData();data.set('file',new File(['fixture'],'errors.xlsx'));data.set('mode','add');
    const response=await POST(new Request('http://localhost/admin/settings/system-labels/errors',{method:'POST',headers:{Origin:'http://localhost'},body:data}));
    expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toContain('attachment');
    const wb=XLSX.read(await response.arrayBuffer(),{type:'array'});
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Errors)).toMatchObject([{Worksheet:'division',Row:2,Message:'Code is required.'}]);
    expect(calls.admin).toHaveBeenCalledOnce();expect(calls.preview).toHaveBeenCalledOnce();
  });
  it('rejects cross-site requests before reading permissions or workbook data',async()=>{
    const response=await POST(new Request('http://localhost/admin/settings/system-labels/errors',{method:'POST',headers:{Origin:'http://other.invalid'},body:'x'}));
    expect(response.status).toBe(403);expect(calls.admin).not.toHaveBeenCalled();expect(calls.preview).not.toHaveBeenCalled();
  });
  it('bounds the streamed request before parsing or previewing it',async()=>{
    const response=await POST(new Request('http://localhost/admin/settings/system-labels/errors',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'multipart/form-data; boundary=test'},body:'x'.repeat(LABEL_UPLOAD_REQUEST_MAX_BYTES+1)}));
    expect(response.status).toBe(413);expect(calls.preview).not.toHaveBeenCalled();
  });
});

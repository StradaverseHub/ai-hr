import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
const calls=vi.hoisted(()=>({admin:vi.fn(async()=>({s:{}})),preview:vi.fn(),locale:{value:'en'}}));
vi.mock('../lib/scope',()=>({scopedAdmin:calls.admin}));
vi.mock('../app/admin/settings/system-labels/import-actions',()=>({previewLabelsAction:calls.preview}));
// Board c074c6b8: the report is written in the request's language (next-intl's request translator).
vi.mock('next-intl/server',async()=>{
  const {labelRootTranslator}=await import('./label-import-translators');
  const catalogues={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default} as Record<string,object>;
  return {getTranslations:vi.fn(async()=>labelRootTranslator(calls.locale.value,catalogues[calls.locale.value]))};
});
import { LABEL_UPLOAD_REQUEST_MAX_BYTES } from '../lib/system-label-upload';
import { POST } from '../app/admin/settings/system-labels/errors/route';
import { labelImportProblemLines } from '../lib/system-label-import-problems';
import { importProblemSheetRows } from '../lib/import-problem-workbook';
import { labelProblemTranslator } from '../lib/system-label-import-problems';
import { labelRootTranslator } from './label-import-translators';
const previewRows=[
  {sheet:'division',row:2,outcome:'error',message:'Code is required.',values:{Code:''},before:null,after:{},reason:'required',reasonField:'Code',reasonDetail:'required',reasonColumn:'Code'},
  {sheet:'department',row:5,outcome:'error',message:'Company must be included in Criteria Companies.',values:{Code:'FIN',Company:'Fictional A','Criteria Companies':'Fictional B'},before:null,after:{},reason:'invalidCriteriaCompany',reasonDetail:'companyNotInCriteria',reasonColumn:'Company'},
  {sheet:'division',row:3,outcome:'add',selected:true,message:'Valid new code.',values:{Code:'NEW'},before:null,after:{}},
] as const;
beforeEach(()=>{vi.clearAllMocks();calls.locale.value='en';calls.preview.mockResolvedValue({ok:true,preview:{rows:previewRows}});});
const request=()=>{const data=new FormData();data.set('file',new File(['fixture'],'errors.xlsx'));data.set('mode','add');
  return new Request('http://localhost/admin/settings/system-labels/errors',{method:'POST',headers:{Origin:'http://localhost'},body:data});};
describe('authenticated label error download',()=>{
  it.each([['en',en],['ms',ms]] as const)('returns a real safe Excel attachment of the check screen lines, in the request language (%s)',async(locale,messages)=>{
    calls.locale.value=locale;
    const response=await POST(request());
    expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toContain('attachment');
    const wb=XLSX.read(await response.arrayBuffer(),{type:'array'});
    const rows=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors,{header:1,raw:false,defval:''});
    const t=labelRootTranslator(locale,messages);
    // Exactly the lines the check screen renders for the same preview, through the same adapter.
    expect(rows).toEqual(importProblemSheetRows({lines:labelImportProblemLines([...previewRows],t),t:labelProblemTranslator(t)}));
    const h=messages.importProblems.headers;
    expect(rows[0]).toEqual([h.row,h.category,h.reference,h.field,h.value,h.problem,h.correction,h.stage,h.result]);
    expect(rows.slice(1).map(r=>r[0])).toEqual(['2','5']);
    expect(rows[1][5]).toBe(messages.labelsImportWizard.problem.required.replace('{field}',messages.labelsImportWizard.fields.Code));
    expect(rows[2][5]).toBe(messages.labelsImportWizard.problem.companyNotInCriteria);
    if(locale==='en')expect(rows[2][5]).toBe('Company must be included in Criteria Companies.');
    expect(rows.flat()).not.toContain('NEW');
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

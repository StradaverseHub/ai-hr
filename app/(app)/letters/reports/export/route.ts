import {getLocale} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {readLetterReport} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {letterReportFilter} from '@/lib/letter-report-filter';
import {letterReportWorkbook,letterReportPdf,LetterReportExportError} from '@/lib/letter-report';
import {LETTER_LANGUAGES} from '@/lib/letter-model';
import {reportLabels} from '../labels';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
export async function GET(request:Request){
 try{
  const params=new URL(request.url).searchParams,format=params.get('format'),hash=params.get('hash');if(!['xlsx','pdf'].includes(format??'')||!hash||!/^[0-9a-f]{64}$/.test(hash))return Response.json({error:'invalid'},{status:400,headers});
  const {s:ctx,scopeIds}=await scopedSession(),filter=letterReportFilter(params),report=await readLetterReport(ctx,{...filter,companyIds:scopeIds,exportAll:true,expectedDataHash:hash}),labels=await reportLabels(),locale=await getLocale();
  if(!(LETTER_LANGUAGES as readonly string[]).includes(locale))throw new LetterWorkflowError('configuration','language');
  const content=format==='xlsx'?new Uint8Array(letterReportWorkbook(report,labels)):(await letterReportPdf(report,labels,locale as typeof LETTER_LANGUAGES[number])).bytes;
  return new Response(new Uint8Array(content),{headers:{...headers,'content-type':format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf','content-disposition':`attachment; filename="letters-${filter.from}-${filter.to}.${format}"`,'content-length':String(content.byteLength)}});
 }catch(error){
  const code=error instanceof AuthRequiredError?'permission':error instanceof LetterReportExportError?error.code:error instanceof LetterWorkflowError?(error.detail==='reportExportLimit'?'exportLimit':error.code):'unavailable';
  return Response.json({error:code},{status:error instanceof AuthRequiredError?401:code==='permission'?403:code==='stale'?409:code==='unavailable'?503:400,headers});
 }
}

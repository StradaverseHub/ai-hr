import type {LetterReport,LetterReportRow} from '../core/letters';
import {renderLetterPdf} from './letter-pdf';
import type {LetterDocument} from './letter-model';
import * as XLSX from 'xlsx';
import type {LetterState} from './letter-workflow';

export const LETTER_REPORT_COLUMNS=['reference','employee_name','employee_code','company_name','department_name','category','state','created_at','submitted_at','approved_at','issued_at','viewed_at','acknowledged_at','approval_due_at','acknowledgement_due_at','approval_overdue','acknowledgement_overdue','approval_hours','issue_hours','acknowledgement_hours'] as const satisfies readonly (keyof LetterReportRow)[];
export type LetterReportLabels={title:string;generatedBy:string;generatedAt:string;period:string;timezone:string;dataHash:string;summary:string;details:string;unknown:string;yes:string;no:string;columns:Record<typeof LETTER_REPORT_COLUMNS[number],string>;metrics:Record<keyof LetterReport['summary'],string>;states:Record<LetterState,string>};
function cells(row:LetterReportRow,labels:LetterReportLabels){return LETTER_REPORT_COLUMNS.map(key=>{
 const value=row[key];if(value===null)return labels.unknown;if(typeof value==='boolean')return value?labels.yes:labels.no;if(key==='state')return labels.states[String(value) as LetterState]??String(value);return value;
});}
/** Both exports consume the exact complete report DTO. They never fetch HR data or recompute figures. */
export class LetterReportExportError extends Error{constructor(public code:'incomplete'|'pdfLimit'){super('letterReport:'+code);}}
function complete(report:LetterReport){if(report.nextCursor||report.rows.length!==report.summary.total)throw new LetterReportExportError('incomplete');}
export function letterReportWorkbook(report:LetterReport,labels:LetterReportLabels):Uint8Array{
 complete(report);const book=XLSX.utils.book_new();
 const summary:(string|number|null)[][]=[[labels.title],[labels.generatedBy,report.generatedBy],[labels.generatedAt,report.generatedAt],[labels.period,`${report.period.from} - ${report.period.to}`],[labels.timezone,report.timezone],[labels.dataHash,report.dataHash],[],...[...Object.entries(report.summary)].map(([key,value])=>[labels.metrics[key as keyof LetterReport['summary']],value??labels.unknown])];
 const summarySheet=XLSX.utils.aoa_to_sheet(summary),detailSheet=XLSX.utils.aoa_to_sheet([LETTER_REPORT_COLUMNS.map(key=>labels.columns[key]),...report.rows.map(row=>cells(row,labels))]);
 summarySheet['!cols']=[{wch:34},{wch:70}];detailSheet['!cols']=LETTER_REPORT_COLUMNS.map(key=>({wch:key.endsWith('_at')?28:24}));
 // All HR text is a string cell; caller-supplied names never become spreadsheet formulas.
 const sheet=(index:number,title:string)=>`${index} ${title}`.replace(/[\\/?*\[\]:]/g,' ').slice(0,31);
 XLSX.utils.book_append_sheet(book,summarySheet,sheet(1,labels.summary));XLSX.utils.book_append_sheet(book,detailSheet,sheet(2,labels.details));return XLSX.write(book,{type:'array',bookType:'xlsx',compression:true}) as Uint8Array;
}
export async function letterReportPdf(report:LetterReport,labels:LetterReportLabels,language:LetterDocument['language']){
 complete(report);
 if(report.rows.length>1000)throw new LetterReportExportError('pdfLimit');
 const text=(value:string)=>({type:'text' as const,text:value});
 const blocks:LetterDocument['blocks']=[{type:'paragraph',content:[text(`${labels.period}: ${report.period.from} - ${report.period.to} (${report.timezone})`)]},{type:'paragraph',content:[text(`${labels.dataHash}: ${report.dataHash}`)]},{type:'heading',level:2,content:[text(labels.summary)]},{type:'table',rows:Object.entries(report.summary).map(([key,value])=>[[text(labels.metrics[key as keyof LetterReport['summary']])],[text(value===null?labels.unknown:String(value))]])}];
 // Detail rows are grouped per letter so the PDF remains readable across 20 columns and all six scripts.
 for(const row of report.rows){blocks.push({type:'heading',level:2,content:[text(row.reference)]},{type:'table',rows:cells(row,labels).map((value,index)=>[[text(labels.columns[LETTER_REPORT_COLUMNS[index]])],[text(String(value))]])});}
 return renderLetterPdf({document:{version:1,language,blocks:blocks as ReturnType<typeof import('./letter-model').renderLetterDocument>['document']['blocks']},reference:labels.details,title:labels.title,signature:{name:`${labels.generatedBy}: ${report.generatedBy}`,caption:labels.generatedAt,timestamp:report.generatedAt},maxPages:2000});
}

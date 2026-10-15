import * as XLSX from 'xlsx';
import type {AdminReport} from './admin-report-model';
/** Explicit string cells remain text, including spreadsheet-formula-like employee names. */
export function buildAssessmentAdminWorkbook(report:AdminReport):Buffer{
 const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([[report.title],[],report.columns,...report.rows]);
 sheet['!cols']=report.columns.map((label,i)=>({wch:Math.min(60,Math.max(10,label.length+2,...report.rows.slice(0,300).map(r=>String(r[i]??'').length+2)))}));
 XLSX.utils.book_append_sheet(book,sheet,'Report');return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;
}

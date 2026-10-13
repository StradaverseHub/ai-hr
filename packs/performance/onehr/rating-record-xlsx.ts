import * as XLSX from 'xlsx';
import { ratingRecordCell, ratingRecordExportRow, ratingRecordHeaders, type RatingRecord } from './rating-record-model';
export function buildRatingRecordWorkbook(input:{cycle:string;scope:string;records:RatingRecord[];generatedAt:Date}):Buffer{
 const book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[...ratingRecordHeaders],...input.records.map(r=>ratingRecordExportRow(r).map(ratingRecordCell))]),'Ratings');
 const generated=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'short',timeStyle:'short',hour12:false}).format(input.generatedAt);
 const about=[['Item','Detail'],['Cycle',input.cycle],['Scope',input.scope],['Generated (MYT)',generated],['People',input.records.length],
 ['What this is',"Scores and bands recorded at the last sign-off or calibration lock. A tier's band is blank until that tier locks. Archived cycle records are frozen."],
 ['Scores',"Performance: Mechanism A is 1–5; Mechanism B is achievement %. Potential combines the 360 and reviewed competency using the configured grade split, out of the sum of their maxima. Pending competency approval uses the 360 alone. 'Share %' shows each assessment's achievement percentage."],
 ['Visibility','This HR export includes recorded scores. Employee releases remain independent. Calibration justifications and rater identities are excluded.']];
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(about.map(row=>row.map(ratingRecordCell))),'About');
 return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;
}

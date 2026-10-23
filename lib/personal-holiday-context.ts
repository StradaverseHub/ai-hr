/** Display context over the retained holiday owners. Never changes a day's Attendance status. */
export type PersonalOriginalHoliday={date:string;name:string};
export type PersonalReplacementHoliday={sourceDate:string;sourceName:string;replacementDate:string|null;status:string;coverageReason:string|null};
export function personalHolidayContext(date:string,originals:readonly PersonalOriginalHoliday[],replacements:readonly PersonalReplacementHoliday[],labels:{original:string;replacement:string;review:string}) {
 const lines=originals.filter(row=>row.date===date).map(row=>`${labels.original}: ${row.name}`);
 for(const row of replacements){
  if(row.sourceDate!==date&&row.replacementDate!==date)continue;
  if(row.coverageReason||row.status==='review')lines.push(`${labels.review}: ${row.sourceName} (${row.sourceDate})`);
  else if(row.replacementDate)lines.push(`${labels.replacement}: ${row.replacementDate} · ${row.sourceName} (${row.sourceDate})`);
 }
 return [...new Set(lines)];
}

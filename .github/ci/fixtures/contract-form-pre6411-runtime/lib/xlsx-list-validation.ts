/** SheetJS CE emits names but not list validation. Add bounded OOXML ranges to our own generated file.
 * Schema: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.datavalidation */
export type XlsxNamedListValidation={sheetIndex:number;column:number;name:string;lastRow:number};
const columnName=(index:number)=>{let n=index+1,result='';while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;};
export async function addXlsxListValidation(bytes:Uint8Array,lists:readonly XlsxNamedListValidation[]) {
 if(!lists.length)return bytes;
 const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(bytes);
 for(const sheetIndex of [...new Set(lists.map(list=>list.sheetIndex))]) {
  const path=`xl/worksheets/sheet${sheetIndex+1}.xml`,entry=zip.file(path);if(!entry)throw new Error('Generated template sheet is missing.');
  const applicable=lists.filter(list=>list.sheetIndex===sheetIndex);
  const nodes=applicable.map(list=>{
   if(!Number.isSafeInteger(list.column)||list.column<0||list.column>255||!Number.isSafeInteger(list.lastRow)||list.lastRow<2||list.lastRow>501||!/^AIHR_Personnel_[0-9_]+$/.test(list.name))throw new Error('Invalid template validation range.');
   const col=columnName(list.column);
   return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" sqref="${col}2:${col}${list.lastRow}"><formula1>${list.name}</formula1></dataValidation>`;
  }).join('');
  const xml=await entry.async('string');if(xml.includes('<dataValidations'))throw new Error('Template validations already exist.');
  const insertion=xml.search(/<(?:hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/);
  if(insertion<0)throw new Error('Generated template worksheet is malformed.');
  zip.file(path,xml.slice(0,insertion)+`<dataValidations count="${applicable.length}">${nodes}</dataValidations>`+xml.slice(insertion));
 }
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

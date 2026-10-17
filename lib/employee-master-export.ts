/** Typed Employee Master serializers. No row data is accepted from the browser. */
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { masterValueText } from './employee-master-cell-format';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { bestFaceFor, embedPayslipFaces, payslipFaceScripts } from './payslip-pdf-fonts';
import type { EmployeeMasterResult, EmployeeMasterSpec, MasterCell, MasterColumn, MasterSection, MasterTotal } from './employee-master-report';
import type { PersonnelFieldDescriptor } from './personnel-field-registry';
export type MasterExportFormat='xlsx'|'csv'|'pdf';
export type MasterExport={bytes:Uint8Array;contentType:string;filename:string;ext:string};
export const masterCellText=(cell:MasterCell,field?:Pick<PersonnelFieldDescriptor,'type'|'unit'>,column?:Pick<MasterColumn,'format'|'decimals'>):string=>{const value=cell.unavailable?'Unavailable — '+cell.unavailable.replaceAll('-',' '):masterValueText(cell.value,field,column)??cell.display??(cell.value==null?'':typeof cell.value==='boolean'?cell.value?'Yes':'No':String(cell.value));return cell.recordedKind==='intent'?value+' (recorded intent)':value;};
const safeCsv=(value:string)=>/^[\s\u0000-\u001f]*[=+@-]/.test(value)?"'"+value:value;
type ExportCell=string|number|{kind:'numeric';text:string};
// Only the closed numeric-field/column branches below construct this internal CSV value.
// Ordinary strings (including '-12.5' and leading-zero IDs) retain formula protection.
const csvNumeric=(text:string):ExportCell=>{if(!/^-?\d+(?:\.\d+)?$/.test(text))throw new Error('Invalid numeric presentation.');return {kind:'numeric',text};};
const csv=(rows:ExportCell[][])=>'\uFEFF'+rows.map(row=>row.map(value=>'"'+(typeof value==='object'?value.text:typeof value==='number'?String(value):safeCsv(value)).replaceAll('"','""')+'"').join(',')).join('\r\n');
const localExcelInstant=(value:string)=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));return new Date(Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second));};
const scopeNotes=(result:EmployeeMasterResult)=>[...(result.sections.some(section=>section.rows.some(row=>row.cells.some(cell=>cell.recordedKind==='intent')))?['Movement cells marked recorded intent come from the frozen scheduled request. They do not prove the change was applied; review its Movement status/history.']:[]),...(result.unknownScopeCount?[`${result.unknownScopeCount} currently visible employments excluded: dated company membership is not recorded.`]:[]),...(result.historyScopeUnavailable?['Some history for currently visible employees is unavailable because dated company membership is not recorded.']:[])];
const slug=(value:string)=>value.replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'Employee-Master';
function sectionName(section:MasterSection,fields:readonly PersonnelFieldDescriptor[]){const field=fields.find(f=>f.owner===section.grain);return section.grain==='employment'?'Employee Master':field?.section??section.grain;}
function header(column:MasterColumn,fields:readonly PersonnelFieldDescriptor[]){return column.header?.trim()||(column.side==='before'?'Before: ':'')+(fields.find(f=>f.id===column.field)?.label??'Unavailable field');}
const totalValue=(total:MasterTotal,fields:readonly PersonnelFieldDescriptor[],columns:readonly MasterColumn[])=>masterValueText(total.value,fields.find(field=>field.id===total.field),columns.find(column=>column.field===total.field&&(column.side??'after')===(total.side??'after')))??total.value;
const totalsText=(totals:MasterTotal[],fields:readonly PersonnelFieldDescriptor[],columns:readonly MasterColumn[])=>totals.map(total=>`${total.side==='before'?'Before: ':''}${fields.find(f=>f.id===total.field)?.label??'Total'}: ${total.unavailable?'Unavailable — '+total.unavailable.replaceAll('-',' '):(total.currency?total.currency+' ':'')+totalValue(total,fields,columns)+(total.unit?' '+total.unit:'')}`).join(' · ');
function totalCells(columns:MasterColumn[],totals:MasterTotal[],fields:readonly PersonnelFieldDescriptor[],numericText:boolean):ExportCell[]{return columns.map(column=>{const total=totals.find(total=>total.field===column.field&&(total.side??'after')===(column.side??'after'));return !total?'':total.unavailable?'Unavailable — '+total.unavailable.replaceAll('-',' '):total.value==null?'':column.format==='text'?String(total.value):numericText?csvNumeric(String(totalValue(total,fields,columns))):Number(total.value);});}
const groupText=(cells:MasterCell[],fields:readonly PersonnelFieldDescriptor[],groups:readonly string[])=>cells.map((cell,index)=>masterCellText(cell,fields.find(field=>field.id===groups[index]))).join(' / ');
function lines(section:MasterSection,fields:readonly PersonnelFieldDescriptor[],groups:readonly string[],numericText=false):ExportCell[][]{
  const result:ExportCell[][]=[section.columns.map(column=>header(column,fields))];
  let lastGroup:string|null=null;
  const subtotal=(key:string)=>{const group=section.groups.find(group=>group.key===key);if(group?.totals.length)result.push(['Subtotal'],totalCells(section.columns,group.totals,fields,numericText));};
  for(const row of section.rows){const key=JSON.stringify(row.group.map(cell=>[cell.referenceId??cell.value,cell.unavailable??null]));
    if(section.groups.length&&key!==lastGroup){if(lastGroup!==null)subtotal(lastGroup);const group=section.groups.find(group=>group.key===key);result.push([groupText(row.group,fields,groups)+` · ${group?.employeeCount??0} employments · ${group?.draftCount??0} drafts · ${group?.rowCount??0} rows`]);lastGroup=key;}
    result.push(row.cells.map((cell,index)=>!cell.unavailable&&cell.recordedKind!=='intent'&&section.columns[index].format!=='text'&&['number','currency'].includes(fields.find(field=>field.id===section.columns[index].field)?.type??'')&&cell.value!=null&&cell.value!==''?numericText?csvNumeric(masterValueText(cell.value,fields.find(field=>field.id===section.columns[index].field),section.columns[index])??String(cell.value)):Number(cell.value):masterCellText(cell,fields.find(field=>field.id===section.columns[index].field),section.columns[index])));
  }
  if(lastGroup!==null)subtotal(lastGroup);
  if(section.totals.length)result.push(['Total'],totalCells(section.columns,section.totals,fields,numericText));
  return result;
}

/** SheetJS CE omits alignment. Clone its generated XFs so selected horizontal alignment does not
 * replace date/number formats, fonts or other metadata. Titles and non-report sheets stay untouched. */
async function alignMasterSheets(zip:JSZip,sections:readonly MasterSection[]){
  const entry=zip.file('xl/styles.xml');if(!entry)throw new Error('Generated report styles are missing.');
  const xml=await entry.async('string'),xfs=xml.match(/<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
  if(!xfs)throw new Error('Generated report cell formats are missing.');
  const formats:string[]=xfs[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)??[];
  if(formats.length!==Number(xfs[1]))throw new Error('Generated report cell formats are inconsistent.');
  const aligned=new Map<string,number>();
  const style=(index:number,horizontal:MasterColumn['align'])=>{
    const key=index+':'+horizontal,known=aligned.get(key);if(known!==undefined)return known;
    const source=formats[index];if(!source)throw new Error('Generated report references an unknown cell format.');
    if(!['left','center','right'].includes(horizontal))throw new Error('Invalid report alignment.');
    let next=source.replace(/\sapplyAlignment="[^"]*"/g,'').replace(/^<xf\b/,'<xf applyAlignment="1"');
    const alignment=`<alignment horizontal="${horizontal}"/>`;
    if(next.endsWith('/>'))next=next.slice(0,-2)+'>'+alignment+'</xf>';
    else if(/<alignment\b/.test(next))next=next.replace(/<alignment\b([^>]*?)(?:\/>|>[\s\S]*?<\/alignment>)/,(_all,attributes:string)=>'<alignment'+attributes.replace(/\shorizontal="[^"]*"/g,'')+` horizontal="${horizontal}"/>`);
    else next=next.replace('</xf>',alignment+'</xf>');
    const id=formats.length;formats.push(next);aligned.set(key,id);return id;
  };
  for(const [index,section]of sections.entries()){
    const path=`xl/worksheets/sheet${index+1}.xml`,sheet=zip.file(path);if(!sheet)throw new Error('Generated report sheet is missing.');
    const contents=(await sheet.async('string')).replace(/<c\b[^>]*>/g,tag=>{
      const address=tag.match(/\br="([A-Z]+)(\d+)"/);if(!address||Number(address[2])<3)return tag;
      const column=section.columns[XLSX.utils.decode_col(address[1])];if(!column)return tag;
      const id=style(Number(tag.match(/\bs="(\d+)"/)?.[1]??0),column.align);
      return /\bs="\d+"/.test(tag)?tag.replace(/\bs="\d+"/,`s="${id}"`):tag.replace(/^<c\b/,`<c s="${id}"`);
    });zip.file(path,contents);
  }
  zip.file('xl/styles.xml',xml.replace(xfs[0],`<cellXfs count="${formats.length}">${formats.join('')}</cellXfs>`));
}

async function excel(result:EmployeeMasterResult,spec:EmployeeMasterSpec,fields:readonly PersonnelFieldDescriptor[],title:string):Promise<Uint8Array>{
  const book=XLSX.utils.book_new(),freezeCounts:number[]=[];
  for(const [index,section]of result.sections.entries()){
    const data=lines(section,fields,spec.groups),sheet=XLSX.utils.aoa_to_sheet([[title],['As at '+result.asAt+` · ${section.employeeCount} employments · ${section.personCount} people · ${section.draftCount} drafts · ${section.rowCount} rows`],...data]);
    // Explicit strings preserve IDs/leading zeros and never become formulas. Month-only facts stay YYYY-MM text; no day is invented. Full dates/numbers are typed.
    let outputRow=3,lastGroup:string|null=null;
    for(const row of section.rows){const key=JSON.stringify(row.group.map(cell=>[cell.referenceId??cell.value,cell.unavailable??null]));if(section.groups.length&&key!==lastGroup){if(lastGroup!==null&&section.groups.find(group=>group.key===lastGroup)?.totals.length)outputRow+=2;outputRow++;lastGroup=key;}
      row.cells.forEach((cell,columnIndex)=>{const column=section.columns[columnIndex],field=fields.find(field=>field.id===column.field),address=XLSX.utils.encode_cell({r:outputRow,c:columnIndex});
        if(!cell.unavailable&&cell.value!=null&&cell.value!==''&&column.format!=='text'&&field?.type==='date'&&field.unit!=='month'&&/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(String(cell.value)))sheet[address]={t:'d',v:field.unit==='instant'?localExcelInstant(String(cell.value)):new Date(String(cell.value).length===10?String(cell.value)+'T00:00:00Z':String(cell.value)),z:String(cell.value).length===10?'dd/mm/yyyy':'dd/mm/yyyy hh:mm'};
        else if(!cell.unavailable&&cell.value!=null&&cell.value!==''&&column.format!=='text'&&['number','currency'].includes(field?.type??''))sheet[address]={t:'n',v:Number(cell.value),z:column.decimals?'0.'+'0'.repeat(column.decimals):'0'};
        else sheet[address]={t:'s',v:masterCellText(cell,field,column)};
        if(cell.recordedKind==='intent')sheet[address].c=[{a:'ai-hr',t:'Recorded scheduled intent; this value does not prove the change was applied. Review Movement status/history.'}];
      });outputRow++;
    }
    // Numeric subtotal/grand-total cells keep real values and the same selected column mask.
    section.columns.forEach((column,index)=>{const field=fields.find(field=>field.id===column.field);if(column.format==='text'||!field||!['number','currency'].includes(field.type))return;for(let row=3;row<data.length+2;row++){const cell=sheet[XLSX.utils.encode_cell({r:row,c:index})];if(cell?.t==='n')cell.z=column.decimals?'0.'+'0'.repeat(column.decimals):'0';}});
    sheet['!cols']=section.columns.map(column=>({wch:column.width==='narrow'?14:column.width==='wide'?40:column.width==='medium'?25:22}));
    sheet['!autofilter']={ref:XLSX.utils.encode_range({s:{r:2,c:0},e:{r:Math.max(2,outputRow-1),c:section.columns.length-1}})};
    const name=(sectionName(section,fields).replace(/[\\/:*?\[\]]/g,' ').slice(0,26)+' '+(index+1)).slice(0,31);XLSX.utils.book_append_sheet(book,sheet,name);
    freezeCounts.push(section.columns.findIndex(column=>!column.freeze)<0?section.columns.length:section.columns.findIndex(column=>!column.freeze));
  }
  const notes=scopeNotes(result);if(notes.length)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Report notes'],['As at '+result.asAt],...notes.map(note=>[note])]),'Report notes');
  // SheetJS CE omits freeze panes/alignment. Add only OOXML presentation metadata to its workbook.
  const zip=await JSZip.loadAsync(XLSX.write(book,{type:'array',bookType:'xlsx',cellDates:true}));
  for(const [index,count]of freezeCounts.entries()){const path=`xl/worksheets/sheet${index+1}.xml`,file=zip.file(path);if(!file)continue;const xml=await file.async('string');const pane=`<sheetViews><sheetView workbookViewId="0"><pane xSplit="${count}" ySplit="3" topLeftCell="${XLSX.utils.encode_col(count)}4" activePane="${count?'bottomRight':'bottomLeft'}" state="frozen"/></sheetView></sheetViews>`;zip.file(path,xml.includes('<sheetViews')?xml.replace(/<sheetViews[\s\S]*?<\/sheetViews>/,pane):xml.replace(/<sheetFormatPr|<cols|<sheetData/,match=>pane+match));}
  await alignMasterSheets(zip,result.sections);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
async function pdf(result:EmployeeMasterResult,spec:EmployeeMasterSpec,fields:readonly PersonnelFieldDescriptor[],title:string,brand?:{content:string;mimeType:string}):Promise<Uint8Array>{
  const doc=await PDFDocument.create(),regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const logo=spec.pdf.logo&&brand?brand.mimeType==='image/png'?await doc.embedPng(Buffer.from(brand.content,'base64')):brand.mimeType==='image/jpeg'?await doc.embedJpg(Buffer.from(brand.content,'base64')):null:null;
  const strings=[title,...result.sections.flatMap(section=>lines(section,fields,spec.groups).flat().map(String))],faces=await embedPayslipFaces(doc,payslipFaceScripts(strings));
  const fontFor=(text:string,strong=false)=>{const face=bestFaceFor(text,faces);return face?(strong?face.bold:face.regular):strong?bold:regular;};
  const paper:Record<string,[number,number]>={A4:[595.28,841.89],A3:[841.89,1190.55],Letter:[612,792],Legal:[612,1008]},base=paper[spec.pdf.paper],size: [number,number]=spec.pdf.orientation==='landscape'?[base[1],base[0]]:base;
  const margin=spec.pdf.margins==='narrow'?24:spec.pdf.margins==='wide'?54:36,usable=size[0]-margin*2;
  let pages=0;
  const wrap=(text:string,width:number,font:PDFFont,fontSize=8):string[]=>{const lines:string[]=[];let line='';for(const character of text){const candidate=line+character;try{if(font.widthOfTextAtSize(candidate,fontSize)>width&&line){lines.push(line);line=character;}else line=candidate;}catch{throw new Error('PDF cannot represent a recorded character. Use Excel or CSV to retain it.');}}lines.push(line);return lines;};
  for(const section of result.sections){const frozen=section.columns.flatMap((column,index)=>column.freeze?[index]:[]),rest=section.columns.flatMap((column,index)=>!column.freeze?[index]:[]);const capacity=Math.max(1,Math.floor(usable/100));if(frozen.length>=capacity&&rest.length)throw new Error('Too many frozen columns for this paper size. Reduce frozen columns or use A3 landscape.');
    const bands:number[][]=[];if(!rest.length)bands.push(frozen);else for(let at=0;at<rest.length;at+=capacity-frozen.length)bands.push([...frozen,...rest.slice(at,at+capacity-frozen.length)]);
    for(const [band,indices]of bands.entries()){
      let page:PDFPage,y=0;const widths=indices.map(()=>usable/indices.length);
      const text=(value:string,x:number,yy:number,strong=false,fontSize=8)=>{const font=fontFor(value,strong);page.drawText(value,{x,y:yy,font,size:fontSize,color:rgb(.15,.18,.22)});};
      const start=()=>{if(++pages>1000)throw new Error('This PDF exceeds 1,000 pages. Narrow the report or use Excel.');page=doc.addPage(size);y=size[1]-margin;if(logo){const scale=Math.min(72/logo.width,24/logo.height);page.drawImage(logo,{x:size[0]-margin-logo.width*scale,y:y-12,width:logo.width*scale,height:logo.height*scale});}text(title,margin,y,true,12);y-=18;text(`${sectionName(section,fields)} · as at ${result.asAt} · columns ${band+1}/${bands.length}`,margin,y);y-=18;for(const note of scopeNotes(result))for(const line of wrap(note,usable,regular)){text(line,margin,y);y-=11;}const headerLines=indices.map((index,i)=>wrap(header(section.columns[index],fields),widths[i]-8,fontFor(header(section.columns[index],fields),true)));const height=Math.max(...headerLines.map(value=>value.length))*10+8;let x=margin;headerLines.forEach((lines,i)=>{lines.forEach((line,li)=>text(line,x+4,y-li*10,true));x+=widths[i];});y-=height;};
      start();let lastGroup='';
      const subtotal=(key:string)=>{const group=section.groups.find(group=>group.key===key);if(!group?.totals.length)return;for(const line of wrap('Subtotal · '+totalsText(group.totals,fields,section.columns),usable,regular)){if(y<margin+20)start();text(line,margin,y,true);y-=11;}};
      for(const row of section.rows){const groupKey=JSON.stringify(row.group.map(cell=>[cell.referenceId??cell.value,cell.unavailable??null]));if(row.group.length&&groupKey!==lastGroup){if(lastGroup)subtotal(lastGroup);if(spec.pdf.pageBreakGroups&&lastGroup)start();if(y<margin+50)start();const group=section.groups.find(group=>group.key===groupKey),groupCaption=groupText(row.group,fields,spec.groups)+` · ${group?.employeeCount??0} employments · ${group?.draftCount??0} drafts · ${group?.rowCount??0} rows`;const groupLines=wrap(groupCaption,usable,fontFor(groupText(row.group,fields,spec.groups),true));for(const line of groupLines){if(y<margin+20)start();text(line,margin,y,true);y-=11;}lastGroup=groupKey;}
        const cellLines=indices.map((index,i)=>{const column=section.columns[index],value=masterCellText(row.cells[index],fields.find(field=>field.id===column.field),column);return wrap(value,widths[i]-8,fontFor(value));});const height=Math.max(...cellLines.map(value=>value.length))*10+8;if(height>size[1]-margin*2-60)throw new Error('A recorded value is too long for a PDF page. Use Excel or CSV to retain it.');if(y-height<margin+20)start();let x=margin;cellLines.forEach((lines,i)=>{lines.forEach((line,li)=>text(line,x+4,y-li*10));x+=widths[i];});y-=height;
      }
      if(lastGroup)subtotal(lastGroup);
      for(const line of wrap(totalsText(section.totals,fields,section.columns),usable,regular)){if(y<margin+20)start();text(line,margin,y,true);y-=11;}
    }
  }
  doc.getPages().forEach((page,index)=>page.drawText(`${index+1} / ${pages}`,{x:size[0]-margin-45,y:margin/2,font:regular,size:7}));return doc.save();
}
export async function serializeEmployeeMaster(result:EmployeeMasterResult,spec:EmployeeMasterSpec,fields:readonly PersonnelFieldDescriptor[],title:string,format:MasterExportFormat,brand?:{content:string;mimeType:string}):Promise<MasterExport>{
  const filename=slug(title);
  if(format==='xlsx')return {bytes:await excel(result,spec,fields,title),filename:filename+'.xlsx',ext:'xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  if(format==='pdf')return {bytes:await pdf(result,spec,fields,title,brand),filename:filename+'.pdf',ext:'pdf',contentType:'application/pdf'};
  if(result.sections.length===1&&!scopeNotes(result).length)return {bytes:Buffer.from(csv(lines(result.sections[0],fields,spec.groups,true))),filename:filename+'.csv',ext:'csv',contentType:'text/csv; charset=utf-8'};
  const zip=new JSZip();const notes=scopeNotes(result);if(notes.length)zip.file('Report-notes.txt','As at '+result.asAt+'\r\n'+notes.join('\r\n'));result.sections.forEach((section,index)=>zip.file(slug(sectionName(section,fields))+'-'+(index+1)+'.csv',csv(lines(section,fields,spec.groups,true))));return {bytes:await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}),filename:filename+'.zip',ext:'zip',contentType:'application/zip'};
}

import {readImportFile,MAX_IMPORT_FILE_BYTES} from './import-file';

export type ImportFileSource={name:string;parts:{label:string;text:string;kind?:'text'|'table';formulas?:number;errors?:number}[]};
/** Decode locally; never upload a binary or silently truncate a sheet/document. */
export async function readAssistantImportFile(file:File):Promise<ImportFileSource>{
 if(file.size===0||file.size>MAX_IMPORT_FILE_BYTES)throw Error('size');
 if(!file.name.toLowerCase().endsWith('.pdf')){
  const read=await readImportFile(file,{preparePersonnel:true});
  const parts=read.preparation?.sheets.map(sheet=>({label:sheet.sheetName,text:sheet.text,kind:'table' as const,
   formulas:sheet.source.rows.reduce((n,row)=>n+row.cells.filter(cell=>cell.formula!==undefined).length,0),
   errors:sheet.source.rows.reduce((n,row)=>n+row.cells.filter(cell=>cell.kind==='e').length,0),
  }))??[{label:read.name,text:read.text,kind:'table' as const}];
  if(!parts.length||parts.some(part=>part.text.length>48000))throw Error('size');
  return {name:file.name,parts};
 }
 const pdfjs=await import('pdfjs-dist');
 pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();
 const loading=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true});
 const deadline=setTimeout(()=>{void loading.destroy();},15000);
 try{
  const pdf=await loading.promise;
  if(pdf.numPages>20)throw Error('size');
  const pages:string[]=[];
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
   const page=await pdf.getPage(pageNumber),content=await page.getTextContent();
   const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':'\t'):'').join('');
   if(!text.trim())throw Error('scan');
   pages.push(text);page.cleanup();
   if(pages.join('\n\n').length>48000)throw Error('size');
  }
  const text=pages.join('\n\n');
  if(!text.trim())throw Error('scan');
  return {name:file.name,parts:[{label:file.name,text,kind:'text'}]};
 }finally{clearTimeout(deadline);await loading.destroy();}
}

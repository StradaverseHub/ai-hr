'use strict';
console.log=console.warn=console.error=()=>{};
// A separate process handles employee-controlled documents. It receives bytes only, without app credentials.
const ext=process.argv[2],{pathToFileURL}=require('node:url');
const TEXT_MAX=6000,ROWS=60,COLS=12,UNZIP_MAX=25*1024*1024,MEMBER_MAX=8*1024*1024;
const clipped=text=>Array.from(text).slice(0,TEXT_MAX).join('').trimEnd();
function ok(text){text=(text||'').trim();return text?{status:'ok',text:Array.from(text).length>TEXT_MAX?clipped(text)+'\n[... the rest of the file is not shown]':text}:{status:'no_text',text:''};}
function cell(value){if(value instanceof Date)value=value.toISOString().replace('T',' ').replace(/\.000Z$/,'');const text=String(value??'').replace(/\s+/g,' ').replaceAll('|','\\|');return Array.from(text).slice(0,60).join('')+(Array.from(text).length>60?'…':'');}
function table(data){const rows=data.map(row=>row.slice(0,COLS).map(cell)).filter(row=>row.some(Boolean)).slice(0,ROWS);if(!rows.length)return '';const width=Math.max(...rows.map(row=>row.reduce((last,c,i)=>c?i+1:last,0)));const lines=rows.map(row=>Array.from({length:width},(_,i)=>row[i]??''));return ['| '+lines[0].join(' | ')+' |','| '+Array(width).fill('---').join(' | ')+' |',...lines.slice(1).map(row=>'| '+row.join(' | ')+' |')].join('\n');}
function decode(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1252').decode(bytes);}}
function zipLimits(bytes){
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)throw Error('unreadable');
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw Error('unreadable');
 const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16),total=0;
 if(count===65535||count>10000||offset===0xffffffff)throw Error('too_big');
 for(let i=0;i<count;i++){
  if(offset+46>bytes.length||bytes.readUInt32LE(offset)!==0x02014b50)throw Error('unreadable');
  const size=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32);
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');total+=size;
  const max=ext==='docx'?(name==='word/document.xml'?MEMBER_MAX:UNZIP_MAX):name.startsWith('xl/worksheets/')?2*MEMBER_MAX:name.endsWith('sharedStrings.xml')?MEMBER_MAX:UNZIP_MAX;
  if(size===0xffffffff||total>UNZIP_MAX||size>max)throw Error('too_big');
  offset+=46+nameLength+extra+comment;if(offset>bytes.length)throw Error('unreadable');
 }
}
async function boundedEntry(entry,max){
 return new Promise((resolve,reject)=>{let size=0;const chunks=[],stream=entry.internalStream('nodebuffer');stream.on('data',chunk=>{size+=chunk.length;if(size>max){stream.pause();reject(Error('too_big'));}else chunks.push(chunk);});stream.on('error',reject);stream.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));stream.resume();});
}
async function word(bytes){
 const JSZip=require('jszip'),{SaxesParser}=require('saxes'),zip=await JSZip.loadAsync(bytes),entry=zip.file('word/document.xml');if(!entry)throw Error('unreadable');
 const xml=await boundedEntry(entry,MEMBER_MAX);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('unreadable');
 const parser=new SaxesParser({xmlns:true}),ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main',parts=[],tables=[];let paragraph='',textDepth=0,size=0,stopped=false;
 const append=text=>{if(text){parts.push(text);size+=Array.from(text).length;}if(size>TEXT_MAX){stopped=true;throw Error('enough');}};
 parser.on('opentag',tag=>{if(tag.uri!==ns)return;switch(tag.local){case 'tbl':tables.push({rows:[],row:[],cell:''});break;case 'tr':if(tables.length)tables[tables.length-1].row=[];break;case 'tc':if(tables.length)tables[tables.length-1].cell='';break;case 'p':if(!tables.length)paragraph='';break;case 't':textDepth++;break;}});
 parser.on('text',text=>{if(!textDepth)return;if(tables.length)tables[tables.length-1].cell+=text;else paragraph+=text;});
 parser.on('cdata',text=>{if(!textDepth)return;if(tables.length)tables[tables.length-1].cell+=text;else paragraph+=text;});
 parser.on('closetag',tag=>{if(tag.uri!==ns)return;const current=tables[tables.length-1];switch(tag.local){case 't':textDepth--;break;case 'p':if(!tables.length)append(paragraph.trim());break;case 'tc':if(current&&current.row.length<COLS)current.row.push(current.cell);break;case 'tr':if(current&&current.rows.length<ROWS&&current.row.some(v=>v.trim()))current.rows.push(current.row);break;case 'tbl':if(current){tables.pop();const text=table(current.rows);if(tables.length)tables[tables.length-1].cell+=text;else append(text);}break;}});
 try{for(let i=0;i<xml.length;i+=4096)parser.write(xml.slice(i,i+4096));parser.close();}catch(error){if(!stopped)throw error;}
 return ok(parts.join('\n\n'));
}
function csv(text){
 const candidates=[',',';','\t','|'],counts=candidates.map(()=>[]);let quoted=false,line=candidates.map(()=>0);
 const sample=text.slice(0,4096);
 for(let i=0;i<sample.length;i++){const c=sample[i];if(c==='"'){if(quoted&&sample[i+1]==='"'){i++;continue;}quoted=!quoted;}else if(!quoted){if(c==='\n'){line.forEach((n,j)=>counts[j].push(n));line=candidates.map(()=>0);}else candidates.forEach((delimiter,j)=>{if(c===delimiter)line[j]++;});}}
 if(!counts.some(values=>values.length))line.forEach((n,j)=>counts[j].push(n));
 const scores=counts.map(values=>{const positive=values.filter(n=>n>0);return positive.length===values.length?positive.reduce((n,v)=>n+v,0)/Math.max(1,positive.length):0;}),best=Math.max(...scores),delimiter=candidates[Math.max(0,scores.indexOf(best))];
 const rows=[];let row=[],field='';quoted=false;
 for(let i=0;i<text.length&&rows.length<ROWS;i++){const c=text[i];if(c==='"'&&(quoted||!field)){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===delimiter){row.push(field);field='';}else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';}else field+=c;}
 if(rows.length<ROWS&&(field||row.length)){row.push(field);rows.push(row);}return rows;
}
async function extract(bytes){
 if(ext==='txt')return ok(decode(bytes));
 if(ext==='csv')return ok(table(csv(decode(bytes.subarray(0,512*1024)))));
 if(ext==='docx'||ext==='xlsx')zipLimits(bytes);
 if(ext==='docx')return word(bytes);
 if(ext==='xlsx'){
  const XLSX=require('xlsx'),book=XLSX.read(bytes,{type:'buffer',raw:true,sheetRows:ROWS,cellDates:true,bookVBA:false,cellStyles:false}),parts=[];let size=0;
  for(const name of book.SheetNames.slice(0,4)){const text=table(XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,raw:true,defval:'',range:{s:{r:0,c:0},e:{r:ROWS-1,c:COLS-1}}}));if(text){const part='### Sheet: '+name+'\n'+text;parts.push(part);size+=part.length;}if(size>TEXT_MAX)break;}
  return ok(parts.join('\n\n'));
 }
 if(ext==='pdf'){
  const pdfjs=await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href),task=pdfjs.getDocument({data:new Uint8Array(bytes),password:'',disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,maxImageSize:0,stopAtErrors:true,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,disableAutoFetch:true,disableStream:true,disableRange:true}),parts=[];let size=0;
  try{const pdf=await task.promise;for(let page=1;page<=Math.min(pdf.numPages,15);page++){const content=await(await pdf.getPage(page)).getTextContent(),text=content.items.map(item=>'str'in item?item.str+(item.hasEOL?'\n':' '):'').join('').trim();if(text){parts.push(text);size+=text.length;}if(size>TEXT_MAX)break;}return ok(parts.join('\n--- page ---\n'));}finally{await task.destroy();}
 }
 return {status:'unsupported',text:''};
}
let input=[],size=0;process.stdin.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){process.stdout.write(JSON.stringify({status:'too_big',text:''}));process.exit(0);}input.push(chunk);});
process.stdin.on('end',async()=>{let result;try{result=await extract(Buffer.concat(input));}catch(error){result={status:error.message==='too_big'?'too_big':'unreadable',text:''};}process.stdout.write(JSON.stringify(result));process.exit(0);});

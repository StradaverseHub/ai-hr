import {PDFDocument,StandardFonts,rgb,degrees,type PDFFont} from 'pdf-lib';
import {embedPayslipFaces,payslipFaceScripts,isWinAnsiCodePoint} from './payslip-pdf-fonts';
import type {LetterInline,renderLetterDocument} from './letter-model';
import {toBuffer} from 'qrcode';

type Document=ReturnType<typeof renderLetterDocument>['document'];
type Run={text:string;font:PDFFont;width:number;italic:boolean;underline:boolean};
export type LetterPdfSignature={name:string;caption:string;timestamp:string;stamp?:Uint8Array};
export type LetterPdfInput={
 document:Document;reference:string;title:string;
 /** Already-localized evidence of the authenticated internal approval, never a legal signature claim. */
 signature:LetterPdfSignature;
 /** A second authenticated party for countersigned lifecycle documents. */
 additionalSignatures?:LetterPdfSignature[];
 letterhead?:Uint8Array;
 /** Frozen document brand colour, when its author includes a letterhead block. */
 accentColor?:string;
 verification?:{url:string;caption:string};
 /** Internal report exports may span more pages; official letters retain the smaller default. */
 maxPages?:number;
};
/** Only frozen, resolved text and private validated PNG bytes enter this renderer. No fetch or HR reads. */
export async function renderLetterPdf(input:LetterPdfInput){
 if(input.accentColor!==undefined&&!/^#[0-9a-fA-F]{6}$/.test(input.accentColor))throw new Error('Invalid document brand colour');
 const maxPages=input.maxPages??200;if(!Number.isInteger(maxPages)||maxPages<1||maxPages>2000)throw new Error('Invalid PDF page limit');
 if(input.additionalSignatures&&input.additionalSignatures.length>1)throw new Error('Too many document signatures');
 const signatures=[input.signature,...input.additionalSignatures??[]];
 const strings:string[]=[input.reference,input.title,...signatures.flatMap(signature=>[signature.name,signature.caption,signature.timestamp])];
 if(input.verification)strings.push(input.verification.caption);
 for(const block of input.document.blocks){
  const cells=block.type==='table'?block.rows.flat():block.type==='list'?block.items:[block.content];
  for(const cell of cells)for(const inline of cell){if(inline.type!=='text')throw new Error('Unresolved letter field');strings.push(inline.text);}
 }
 if(strings.some(value=>typeof value!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))throw new Error('Invalid letter text');
 const pdf=await PDFDocument.create();pdf.setTitle(input.title);pdf.setSubject(input.reference);pdf.setProducer('ai-hr');
 const regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const faces=await embedPayslipFaces(pdf,payslipFaceScripts(strings));
 const header=input.letterhead?await pdf.embedPng(input.letterhead):null;
 const width=595.28,height=841.89,left=48,right=width-48,bottom=58,bodyWidth=right-left;
 let page=pdf.addPage([width,height]),y=height-48;
 const bounds:{page:number;x:number;y:number;width:number;height:number}[]=[];
 function runs(content:LetterInline[],size:number,forceBold=false):Run[]{
  const result:Run[]=[];
  for(const inline of content){
   if(inline.type!=='text')throw new Error('Unresolved letter field');
   const strong=forceBold||Boolean(inline.marks?.includes('bold')),italic=Boolean(inline.marks?.includes('italic')),underline=Boolean(inline.marks?.includes('underline'));
   for(const char of inline.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ')){
    const cp=char.codePointAt(0)!;
    const face=isWinAnsiCodePoint(cp)?null:faces.find(face=>face.chars.has(cp));
    if(char!=='\n'&&!isWinAnsiCodePoint(cp)&&!face)throw new Error('Unsupported letter glyph: '+cp.toString(16));
    const font=face?(strong?face.bold:face.regular):(strong?bold:regular),previous=result.at(-1);
    if(char!=='\n'&&previous&&previous.text!=='\n'&&previous.font===font&&previous.italic===italic&&previous.underline===underline)previous.text+=char;
    else result.push({text:char,font,width:0,italic,underline});
   }
  }
  return result;
 }
 function wrap(content:LetterInline[],available:number,size:number,strong=false):Run[][]{
  const lines:Run[][]=[[]];let used=0;
  for(const run of runs(content,size,strong)){
   if(run.text==='\n'){lines.push([]);used=0;continue;}
   // Preserve every character; long identifiers and scripts without spaces still wrap within the cell.
   for(const token of run.text.match(/\s+|[^\s]+/gu)??[]){
    const tokenWidth=run.font.widthOfTextAtSize(token,size);
    if(tokenWidth<=available){if(used&&used+tokenWidth>available){lines.push([]);used=0;}lines.at(-1)!.push({...run,text:token,width:tokenWidth});used+=tokenWidth;}
    else for(const char of token){const charWidth=run.font.widthOfTextAtSize(char,size);if(charWidth>available)throw new Error('Letter glyph exceeds column width');if(used&&used+charWidth>available){lines.push([]);used=0;}lines.at(-1)!.push({...run,text:char,width:charWidth});used+=charWidth;}
   }
  }
  return lines;
 }
 function newPage(){if(pdf.getPageCount()>=maxPages)throw new Error('PDF page limit exceeded');page=pdf.addPage([width,height]);y=height-48;}
 function space(needed:number){if(y-needed<bottom)newPage();}
 function drawLine(line:Run[],x:number,baseline:number,size:number){
  let cursor=x;
  for(const run of line){page.drawText(run.text,{x:cursor,y:baseline,font:run.font,size,color:rgb(.12,.14,.17),...(run.italic?{ySkew:degrees(10)}:{})});if(run.underline)page.drawLine({start:{x:cursor,y:baseline-2},end:{x:cursor+run.width,y:baseline-2},thickness:.5});cursor+=run.width;}
  bounds.push({page:pdf.getPageCount(),x,y:baseline,width:cursor-x,height:size});
 }
 function paragraph(content:LetterInline[],size=11,strong=false,indent=0){for(const line of wrap(content,bodyWidth-indent-4,size,strong)){space(size*1.65);drawLine(line,left+indent,y-size,size);y-=size*1.65;}y-=7;}
 const plain=(text:string):LetterInline[]=>[{type:'text',text}];
 if(input.accentColor){const color=input.accentColor;page.drawRectangle({x:left,y:y-4,width:bodyWidth,height:4,color:rgb(parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255)});y-=18;}
 if(header){const dimensions=header.scale(Math.min(bodyWidth/header.width,80/header.height));page.drawImage(header,{x:left,y:y-dimensions.height,width:dimensions.width,height:dimensions.height});y-=dimensions.height+18;}
 paragraph(plain(input.title),17,true);paragraph(plain(input.reference),9);y-=7;
 for(const block of input.document.blocks){
  if(block.type==='heading')paragraph(block.content,block.level===1?16:block.level===2?14:12,true);
  else if(block.type==='paragraph')paragraph(block.content);
  else if(block.type==='list')for(const [index,item]of block.items.entries())paragraph([...plain(block.ordered?`${index+1}. `:'- '),...item],11,false,14);
  else if(block.type==='table'){
   const columns=Math.max(...block.rows.map(row=>row.length));if(!columns||columns>12)throw new Error('Unsupported letter table');const cellWidth=bodyWidth/columns;
   for(const cells of block.rows){const lines=Array.from({length:columns},(_,index)=>wrap(cells[index]??[],cellWidth-16,10));const count=Math.max(...lines.map(cell=>cell.length));
    // Tall rows continue as bounded table bands on the following page; no row is clipped or discarded.
    for(let rowLine=0;rowLine<count;){space(32);const fit=Math.max(1,Math.floor((y-bottom-12)/17)),take=Math.min(fit,count-rowLine),bandHeight=take*17+12,top=y;
     for(let column=0;column<columns;column++){const x=left+column*cellWidth;page.drawRectangle({x,y:top-bandHeight,width:cellWidth,height:bandHeight,borderColor:rgb(.75,.77,.79),borderWidth:.5});for(let line=0;line<take;line++)drawLine(lines[column][rowLine+line]??[],x+8,top-17-line*17,10);}
     y-=bandHeight;rowLine+=take;if(rowLine<count)newPage();
    }
   }y-=12;
  }
 }
 for(const signature of signatures){
  const stamp=signature.stamp?await pdf.embedPng(signature.stamp):null;
  const signatureHeight=16+(stamp?Math.min(150/stamp.width,65/stamp.height)*stamp.height+10:0)+wrap(plain(signature.name),bodyWidth-4,11,true).length*11*1.65+wrap(plain(signature.caption),bodyWidth-4,9).length*9*1.65+wrap(plain(signature.timestamp),bodyWidth-4,9).length*9*1.65+21;
  space(signatures.length===1?140:Math.max(140,signatureHeight));y-=16;
  if(stamp){const dimensions=stamp.scale(Math.min(150/stamp.width,65/stamp.height));page.drawImage(stamp,{x:left,y:y-dimensions.height,width:dimensions.width,height:dimensions.height});y-=dimensions.height+10;}
  paragraph(plain(signature.name),11,true);paragraph(plain(signature.caption),9);paragraph(plain(signature.timestamp),9);
 }
 if(input.verification){
  const url=new URL(input.verification.url);if(url.protocol!=='https:'||url.username||url.password||input.verification.url.length>1024)throw new Error('Invalid letter verification URL');
  const qr=await pdf.embedPng(await toBuffer(input.verification.url,{type:'png',width:512,margin:4,errorCorrectionLevel:'M'}));space(150);page.drawImage(qr,{x:left,y:y-104,width:104,height:104});y-=114;paragraph(plain(input.verification.caption),9);
 }
 const pages=pdf.getPages();for(const [index,leaf]of pages.entries())leaf.drawText(`${index+1} / ${pages.length}`,{x:right-45,y:30,font:regular,size:8,color:rgb(.4,.4,.4)});
 return {bytes:await pdf.save(),pages:pages.length,bounds};
}

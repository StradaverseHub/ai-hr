import {PDFDocument,StandardFonts,type PDFFont} from 'pdf-lib';
import {embedPayslipFaces,payslipFaceScripts,isWinAnsiCodePoint} from '../../lib/payslip-pdf-fonts';
const fold=(value:string)=>value.normalize('NFC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/…/g,'...').replace(/\s+/g,' ').trim();
/** Report-only PDF. Draw shaped grapheme runs so Thai and Tamil marks stay with their letters. */
export async function renderRewardSetupPdf(title:string,lines:string[]){
 const values=[title,'',...lines].map(fold),pdf=await PDFDocument.create(),latin=await pdf.embedFont(StandardFonts.Helvetica),faces=await embedPayslipFaces(pdf,payslipFaceScripts(values)),segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});pdf.setTitle(title);
 let page=pdf.addPage([842,595]),y=555;
 function draw(runs:{font:PDFFont;text:string}[],size:number){if(y<35){page=pdf.addPage([842,595]);y=555;}let x=32;for(const run of runs){page.drawText(run.text,{x,y,size,font:run.font});x+=run.font.widthOfTextAtSize(run.text,size);}y-=size+8;}
 for(const [i,line] of values.entries()){const size=i===0?16:9;let runs:{font:PDFFont;text:string}[]=[],width=0;for(const {segment}of segmenter.segment(line)){let value=segment;const points=[...segment].map(ch=>ch.codePointAt(0)!);let font=points.every(isWinAnsiCodePoint)?latin:faces.find(face=>points.every(cp=>face.chars.has(cp)))?.regular;if(!font){font=latin;value=points.map(cp=>isWinAnsiCodePoint(cp)?String.fromCodePoint(cp):`[U+${cp.toString(16).toUpperCase()}]`).join('');}const advance=font.widthOfTextAtSize(value,size);if(width+advance>778&&runs.length){draw(runs,size);runs=[];width=0;}const last=runs.at(-1);if(last?.font===font)last.text+=value;else runs.push({font,text:value});width+=advance;}draw(runs,size);}
 return pdf.save();
}

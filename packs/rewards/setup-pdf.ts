import {PDFDocument,StandardFonts} from 'pdf-lib';
import {embedPayslipFaces,payslipFaceScripts,isWinAnsiCodePoint} from '../../lib/payslip-pdf-fonts';
/** Report-only PDF: no letter signature or employment record is created. */
export async function renderRewardSetupPdf(title:string,lines:string[]){
 const pdf=await PDFDocument.create(),latin=await pdf.embedFont(StandardFonts.Helvetica),faces=await embedPayslipFaces(pdf,payslipFaceScripts([title,...lines]));pdf.setTitle(title);let page=pdf.addPage([842,595]),y=555;
 for(const text of [title,'',...lines]){let x=32;const size=text===title?16:9;for(const ch of text){const cp=ch.codePointAt(0)!,font=isWinAnsiCodePoint(cp)?latin:faces.find(f=>f.chars.has(cp))?.regular;if(!font)throw new Error('The report contains an unsupported character.');const width=font.widthOfTextAtSize(ch,size);if(x+width>810){x=32;y-=15;}if(y<35){page=pdf.addPage([842,595]);y=555;}page.drawText(ch,{x,y,size,font});x+=width;}y-=20;}
 return pdf.save();
}

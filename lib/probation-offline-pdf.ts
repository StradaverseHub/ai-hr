import {ProbationError} from './probation-model';

/** Validate original paper evidence before accepting it into Personnel custody. */
export async function validateProbationOfflinePdf(content:Buffer):Promise<void>{
 if(content.length<5||content.length>10*1024*1024||content.subarray(0,5).toString()!=='%PDF-'){
  throw new ProbationError('invalid','Upload the original PDF within 10 MiB.');
 }
 try{
  const {PDFDocument}=await import('pdf-lib');
  const document=await PDFDocument.load(content);
  const pages=document.getPageCount();
  if(pages<1||pages>200)throw new Error('Page count outside evidence limits.');
 }catch{
  throw new ProbationError('invalid','Upload the original readable offline PDF, with one to 200 pages.');
 }
}

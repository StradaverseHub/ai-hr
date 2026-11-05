import 'server-only';
import {PDFDocument,StandardFonts,rgb,type PDFFont} from 'pdf-lib';
import {embedPayslipFaces,payslipFaceScripts,bestFaceFor,isWinAnsiCodePoint} from '@/lib/payslip-pdf-fonts';
import {DEFAULT_FORM,standardJobChoiceKey} from './model';
import type {readJobDocument} from './owner';
type Detail=Awaited<ReturnType<typeof readJobDocument>>;
type Translate=(key:string,values?:Record<string,string|number>)=>string;
/** Controlled four-form document, from the saved form snapshot. No signatures are inferred. */
export async function renderJobDescriptionPdf(detail:Detail,t:Translate):Promise<Uint8Array>{
 const {job,revision:r}=detail,doc=await PDFDocument.create();doc.setTitle(r.title);doc.setAuthor(r.document_owner);doc.setSubject(`${job.job_code} / v${r.version}`);
 const regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 const captions=[...Object.values(r.org_labels),r.title,r.document_owner,...r.definition.sections.flatMap(s=>[s.label,...s.fields.map(f=>f.label)])];
 const allText=[job.company_name,...Object.values(detail.principals),JSON.stringify(r.answers),...captions,...r.definition.sections.flatMap(s=>{const standard=DEFAULT_FORM.sections.find(v=>v.id===s.id);return [t(s.form),standard?t('sections.'+s.id):s.label,...s.fields.map(f=>standard?.fields.some(v=>v.id===f.id)?t(`fields.${s.id}.${f.id}`):f.label)];}),...['jobCode','company','status','owner','preparedBy','approvedBy','effectiveOn','reviewOn','reviews','signatureHint'].map(k=>t(k)),...detail.reviews.flatMap(v=>[v.name,v.comments,t('reviewStates.'+v.decision)])];
 const clean=(v:string)=>v.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[\u2013\u2014\u2212]/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"');
 const faces=await embedPayslipFaces(doc,payslipFaceScripts(allText.map(clean)));
 const runs=(text:string,strong=false)=>{text=clean(text);const preferred=bestFaceFor(text,faces);const out:{font:PDFFont;text:string}[]=[];for(const ch of Array.from(text)){const cp=ch.codePointAt(0)!;const face=preferred?.chars.has(cp)?preferred:faces.find(f=>f.chars.has(cp));const font=face?(strong?face.bold:face.regular):isWinAnsiCodePoint(cp)?(strong?bold:regular):null;if(!font)throw new Error('A document character has no available PDF font.');const previous=out[out.length-1];if(previous?.font===font)previous.text+=ch;else out.push({font,text:ch});}return out;};
 const width=(text:string,size:number,strong=false)=>runs(text,strong).reduce((sum,r)=>sum+r.font.widthOfTextAtSize(r.text,size),0);
 const wrap=(text:string,size:number,max:number,strong=false)=>{const lines:string[]=[];for(const paragraph of clean(text).split('\n')){let line='';for(const word of paragraph.split(/(?<=\s)/u)){if(width(line+word,size,strong)<=max){line+=word;continue;}if(line){lines.push(line.trimEnd());line='';}for(const ch of Array.from(word)){if(line&&width(line+ch,size,strong)>max){lines.push(line.trimEnd());line='';}line+=ch;}}lines.push(line.trimEnd());}return lines.length?lines:[''];};
 const W=595.28,H=841.89,M=38,usable=W-2*M;let page=doc.addPage([W,H]),y=H-M,form='';
 const draw=(text:string,x:number,baseline:number,size=10,strong=false)=>{let cursor=x;for(const run of runs(text,strong)){page.drawText(run.text,{x:cursor,y:baseline,size,font:run.font,color:rgb(.08,.08,.08)});cursor+=run.font.widthOfTextAtSize(run.text,size);}};
 const header=()=>{y=H-M;for(const text of [job.company_name,`${job.job_code} · v${r.version} · ${t('statuses.'+(job.inactive?'inactive':r.status))}`]){for(const line of wrap(text,9,usable)){draw(line,M,y,9);y-=13;}}for(const line of wrap(r.title,14,usable,true)){draw(line,M,y-3,14,true);y-=19;}if(form){draw(form,M,y-2,10,true);y-=18;}page.drawLine({start:{x:M,y:y-3},end:{x:W-M,y:y-3},thickness:.8,color:rgb(.2,.2,.2)});y-=18;};
 const next=()=>{page=doc.addPage([W,H]);header();};
 const ensure=(height:number)=>{if(y-height<50)next();};
 const paragraph=(text:string,strong=false,size=10,indent=0)=>{for(const line of wrap(text,size,usable-indent,strong)){ensure(15);draw(line,M+indent,y,size,strong);y-=15;}};
 const field=(caption:string,value:unknown)=>{const text=value===null||value===undefined||value===''?'—':String(value);ensure(42);paragraph(caption,true,9);paragraph(text,false,10,8);y-=5;page.drawLine({start:{x:M,y:y+2},end:{x:W-M,y:y+2},thickness:.3,color:rgb(.82,.82,.82)});y-=5;};
 header();const human=(id:string|null)=>id?detail.principals[id]??id:'—';
 for(const [key,value] of [['owner',r.document_owner],['preparedBy',human(r.prepared_by)],['approvedBy',human(r.approved_by)],['effectiveOn',r.effective_on],['reviewOn',r.review_on],...Object.entries(r.org_labels)] as [string,unknown][])field(t(key),value);
 for(const section of r.definition.sections){const standard=DEFAULT_FORM.sections.find(s=>s.id===section.id);const title=standard?t('sections.'+section.id):section.label;
  if(form!==t(section.form)){form=t(section.form);next();}ensure(50);paragraph(title,true,12);y-=5;
  const rows=r.answers[section.id]??[];if(!rows.length)paragraph(t('notProvided'));
  for(const [index,row]of rows.entries()){if(section.repeated){ensure(30);paragraph(t('row',{number:index+1}),true,9);}for(const f of section.fields){const caption=standard?.fields.some(v=>v.id===f.id)?t(`fields.${section.id}.${f.id}`):f.label,value=row[f.id],choice=standardJobChoiceKey(section.id,f.id,String(value));field(caption,value===true?t('yes'):value===false?t('no'):choice?t(choice):value);}}
 }
 form=t('reviews');next();for(const review of detail.reviews){field(review.name,`${t('reviewStates.'+review.decision)} · ${review.decided_at??'—'}\n${review.comments}`);ensure(46);page.drawLine({start:{x:M+8,y:y-20},end:{x:M+200,y:y-20},thickness:.6});y-=45;}paragraph(t('signatureHint'),false,9);
 const pages=doc.getPages();for(const [index,p]of pages.entries()){page=p;draw(`${job.job_code} · v${r.version}`,M,27,8);draw(`${index+1} / ${pages.length}`,W-M-42,27,8);}
 return doc.save();
}

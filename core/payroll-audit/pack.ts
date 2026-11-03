/** AI v2 P2-2b — the audit pack: one downloadable archive per company and pay month.
 *
 * For group or HR administrators, and for an auditor with a current grant (read-only). An administrator's download first
 * captures the month now (core/payroll-audit/capture.ts), so the pack is complete as of the download; an auditor's pack is
 * built from what has been captured. Contents, each listed in manifest.json with its sha256 and size:
 *  - summary.pdf: the company and month, the runs, the statutory files and filings, the findings by check and disposition,
 *    the corrections and their root causes, the captures and the tamper check, in the viewer's language (Helvetica: text a
 *    standard PDF font cannot draw becomes '?'; the CSV and JSON files are the lossless evidence);
 *  - captures.json: every capture of the month in chain order (content, content hash, previous and chain hash, writer, time);
 *  - captures.csv: the same, one line per capture, without the content;
 *  - findings.json and findings.csv: every control finding with its evidence and every disposition;
 *  - access-log.csv: who viewed or exported this company's payroll data for the month (from the captures);
 *  - verification.json: the tamper check (core/payroll-audit/verify.ts).
 * The archive's own sha256 is returned and recorded in the access log entry the download writes. No figure is calculated:
 * every amount in the pack is copied from its owner. */
import JSZip from 'jszip';
import {PDFDocument,StandardFonts,rgb,type PDFFont} from 'pdf-lib';
import {and,asc,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {payrollAuditDisposition,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {company,employment,person} from '../../db/schema';
import {isAdmin} from '../../lib/authz-model';
import {toCsv} from '../../lib/csv';
import {embedPayslipFaces,isWinAnsiCodePoint,payslipFaceScripts} from '../../lib/payslip-pdf-fonts';
import {sha256Hex} from './access-log';
import {capturePayrollPeriod,listCapturesTx} from './capture';
import {canReadAuditTx} from './settings';
import {verifyCapturesTx,type CaptureVerification} from './verify';
import {AUDIT_CAPTURE_KINDS,AUDIT_CONTROL_IDS,isPayPeriod,type AuditCaptureKind,type AuditControlId,type AuditDisposition} from './types';

export class AuditPackRefused extends Error{constructor(readonly reason:'not_allowed'|'invalid'){super('Audit pack refused: '+reason);this.name='AuditPackRefused';}}

/** The words the summary prints, in the viewer's language (the route reads them from messages). */
export type AuditPackLabels=Readonly<{title:string;company:string;payPeriod:string;generated:string;by:string;runs:string;runLine:string;
 statutory:string;filingEvidence:string;findings:string;findingLine:string;corrections:string;correctionLine:string;captures:string;captureLine:string;
 verification:string;verified:string;notVerified:string;anchors:string;files:string;none:string;
 /** One finding: `{control}`, `{who}` (the person's name and employee code, as the reader may see them) and `{state}`. */
 findingItem:string;open:string;dispositions:Readonly<Record<AuditDisposition,string>>;
 /** Said on the summary when any character could not be drawn in any font: `{count}`. */
 unprintable:string;
 kinds:Readonly<Record<AuditCaptureKind,string>>;controls:Readonly<Record<AuditControlId,string>>}>;
export type AuditPackFile=Readonly<{name:string;sha256:string;bytes:number}>;
export type AuditPack=Readonly<{filename:string;bytes:Uint8Array;sha256:string;files:readonly AuditPackFile[];captures:number;verification:CaptureVerification;
 companyName:string;unprintable:number}>;

const fill=(template:string,values:Record<string,string|number>)=>template.replace(/\{(\w+)\}/g,(_,key)=>key in values?String(values[key]):`{${key}}`);
const fold=(s:string)=>(s??'').replace(/[•∙]/g,'·').replace(/[‘’‛]/g,"'").replace(/[“”]/g,'"').replace(/[‐-―]/g,'-').replace(/…/g,'...');
const iso=(value:unknown)=>value instanceof Date?value.toISOString():value==null?'':String(value);

type Line=Readonly<{text:string;bold?:boolean;gap?:boolean}>;
type Run={text:string;font:PDFFont};
/** The summary, drawn with the repository's own fonts (lib/payslip-pdf-fonts.ts, the faces the payslip and letter documents
 * use): Helvetica for Latin-1, and the embedded, subsetted Noto face of each script the summary actually contains (Latin
 * Extended and Vietnamese, Tamil, Thai, Chinese). Each character is drawn in the face that carries it, run by run, so a line
 * mixing a Chinese company name with a Tamil person's name keeps both (the lib/letter-pdf.ts pattern). A character no face
 * carries is drawn as '?', COUNTED, and the summary then says so on its own page and in the manifest: never silently. */
async function summaryPdf(lines:readonly Line[],unprintableNote:(count:number)=>string):Promise<{bytes:Uint8Array;unprintable:number}>{
 const doc=await PDFDocument.create();doc.setProducer('AI HR');doc.setCreator('AI HR audit pack');
 const regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 const faces=await embedPayslipFaces(doc,payslipFaceScripts(lines.map(line=>fold(line.text))));
 let unprintable=0;
 const runsOf=(text:string,strong:boolean):Run[]=>{
  const out:Run[]=[];
  for(const ch of fold(text)){
   const cp=ch.codePointAt(0)!;
   const face=isWinAnsiCodePoint(cp)?null:faces.find(item=>item.chars.has(cp))??null;
   let drawn=ch;
   if(!isWinAnsiCodePoint(cp)&&!face){drawn='?';unprintable++;}
   const font=face?(strong?face.bold:face.regular):(strong?bold:regular),last=out.at(-1);
   if(last&&last.font===font)last.text+=drawn;else out.push({text:drawn,font});
  }
  return out;
 };
 const [w,h]=[595.28,841.89],margin=48,size=9.5,lead=14,maxW=w-2*margin;
 let page=doc.addPage([w,h]),y=h-margin;
 const draw=(runs:readonly Run[],at:number,fontSize:number)=>{let x=margin;for(const run of runs){page.drawText(run.text,{x,y:at,size:fontSize,font:run.font,color:rgb(0.11,0.11,0.12)});
  x+=run.font.widthOfTextAtSize(run.text,fontSize);}};
 /** Words wrap at spaces against the real width of the font each part is drawn in; a word longer than the line breaks
  * between characters rather than running off the page. */
 const wrap=(runs:readonly Run[],fontSize:number):Run[][]=>{
  const out:Run[][]=[[]];let used=0;
  for(const run of runs)for(const token of run.text.match(/\s+|[^\s]+/gu)??[]){
   const width=run.font.widthOfTextAtSize(token,fontSize);
   const place=(text:string,tw:number)=>{if(used&&used+tw>maxW&&text.trim()){out.push([]);used=0;}if(!used&&!text.trim())return;
    const line=out.at(-1)!,last=line.at(-1);if(last&&last.font===run.font)last.text+=text;else line.push({text,font:run.font});used+=tw;};
   if(width<=maxW)place(token,width);else for(const ch of token)place(ch,run.font.widthOfTextAtSize(ch,fontSize));
  }
  return out;
 };
 const write=(line:Line)=>{
  if(line.gap)y-=lead/2;
  const fontSize=line.bold?size+1:size;
  for(const part of wrap(runsOf(line.text,line.bold===true),fontSize)){
   if(y<margin){page=doc.addPage([w,h]);y=h-margin;}
   draw(part,y,fontSize);y-=lead;
  }
 };
 for(const line of lines)write(line);
 if(unprintable>0){const counted=unprintable;write({text:unprintableNote(counted),bold:true,gap:true});unprintable=counted;}
 return {bytes:await doc.save(),unprintable};
}

/** Builds the pack for one company and month. Throws AuditPackRefused when the caller may not read it. */
export async function buildAuditPack(supplied:SessionContext,input:Readonly<{companyId:unknown;payPeriod:unknown}>,labels:AuditPackLabels):Promise<AuditPack>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent)throw new AuditPackRefused('not_allowed');
 if(typeof input.companyId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.companyId)||!isPayPeriod(input.payPeriod))throw new AuditPackRefused('invalid');
 const p={companyId:input.companyId,payPeriod:input.payPeriod};
 const allowed=await withTenant(ctx,tx=>canReadAuditTx(tx,p.companyId));
 if(!allowed)throw new AuditPackRefused('not_allowed');
 // An administrator's pack is complete as of now; an auditor reads what was captured.
 if(isAdmin(ctx))await capturePayrollPeriod(ctx,p).catch(()=>null);
 const generatedAt=new Date();
 const data=await withTenant(ctx,async tx=>{
  const [co]=await tx.select({name:company.legalName}).from(company).where(eq(company.id,p.companyId)).limit(1);
  const captures=await listCapturesTx(tx,ctx.tenantId,p);
  const verification=await verifyCapturesTx(tx,ctx.tenantId,p);
  const findings=await tx.select().from(payrollAuditFinding).where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,p.companyId),
   eq(payrollAuditFinding.payPeriod,p.payPeriod))).orderBy(asc(payrollAuditFinding.detectedAt),asc(payrollAuditFinding.id));
  const dispositions=findings.length?await tx.select().from(payrollAuditDisposition).where(and(eq(payrollAuditDisposition.tenantId,ctx.tenantId),
   inArray(payrollAuditDisposition.findingId,findings.map(row=>row.id)))).orderBy(asc(payrollAuditDisposition.disposedAt),asc(payrollAuditDisposition.id)):[];
  // Who each finding is about, by name where this reader may read the person (an auditor may see only the employee code).
  const employmentIds=[...new Set(findings.map(row=>row.employmentId).filter((id):id is string=>!!id))];
  const people=employmentIds.length?await tx.select({id:employment.id,code:employment.employeeCode,name:person.fullName}).from(employment)
   .leftJoin(person,eq(person.id,employment.personId)).where(inArray(employment.id,employmentIds)):[];
  return {companyName:co?.name??p.companyId,captures,verification,findings,dispositions,people};
 });
 const {captures,verification,findings,dispositions,people}=data;
 const who=(employmentId:string|null)=>{if(!employmentId)return null;const found=people.find(row=>row.id===employmentId);
  return [found?.name,found?.code].filter((v):v is string=>typeof v==='string'&&v.trim()!=='').join(' · ')||employmentId;};
 // The latest version of each captured artefact, for the summary.
 const latest=new Map<string,(typeof captures)[number]>();
 for(const row of captures)latest.set(row.sourceKey,row);
 const ofKind=(kind:AuditCaptureKind)=>[...latest.values()].filter(row=>row.kind===kind);
 const files:{name:string;content:Uint8Array}[]=[];
 const add=(name:string,content:string|Uint8Array)=>files.push({name,content:typeof content==='string'?new TextEncoder().encode(content):content});
 const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
 add('captures.json',json(captures.map(row=>({id:row.id,seq:row.seq,kind:row.kind,sourceKey:row.sourceKey,batchId:row.batchId,capturedAt:iso(row.capturedAt),
  writer:row.writer,writerId:row.writerId,runId:row.runId,contentHash:row.contentHash,prevHash:row.prevHash,chainHash:row.chainHash,content:row.content}))));
 add('captures.csv',toCsv([['seq','kind','source_key','batch_id','captured_at','writer','writer_id','content_sha256','prev_hash','chain_hash'],
  ...captures.map(row=>[row.seq,row.kind,row.sourceKey,row.batchId,iso(row.capturedAt),row.writer,row.writerId,row.contentHash,row.prevHash,row.chainHash])]));
 const findingRows=findings.map(row=>({...row,detectedAt:iso(row.detectedAt),dispositions:dispositions.filter(d=>d.findingId===row.id).map(d=>({...d,disposedAt:iso(d.disposedAt)}))}));
 add('findings.json',json(findingRows));
 add('findings.csv',toCsv([['finding_id','control','subject','batch_id','employment_id','detected_at','evidence_sha256','disposition','note','disposed_by','disposed_at'],
  ...findingRows.flatMap(row=>row.dispositions.length?row.dispositions.map(d=>[row.id,row.controlId,row.subjectKey,row.batchId,row.employmentId,row.detectedAt,row.evidenceHash,
   d.disposition,d.note,d.disposedByUserId,d.disposedAt]):[[row.id,row.controlId,row.subjectKey,row.batchId,row.employmentId,row.detectedAt,row.evidenceHash,'','','','']])]));
 add('access-log.csv',toCsv([['at','actor_type','actor_id','surface','action','batch_id','payslip_id','format','file_sha256','bytes','rows','detail'],
  ...ofKind('access').map(row=>{const c=row.content as {at?:unknown;actorType?:string;actorId?:string;entry?:Record<string,unknown>};const e=c.entry??{};
   return [iso(c.at),c.actorType??'',c.actorId??'',String(e.surface??''),String(e.action??''),String(e.batchId??''),String(e.payslipId??''),String(e.format??''),
    String(e.fileSha256??''),e.bytes==null?'':String(e.bytes),e.rows==null?'':String(e.rows),String(e.detail??'')];})]));
 add('verification.json',json(verification));
 // The summary.
 const L=labels,lines:{text:string;bold?:boolean;gap?:boolean}[]=[];
 lines.push({text:L.title,bold:true},{text:`${L.company}: ${data.companyName}`},{text:`${L.payPeriod}: ${p.payPeriod}`},
  {text:`${L.generated}: ${generatedAt.toISOString()} · ${L.by}: ${ctx.userId}`});
 lines.push({text:L.runs,bold:true,gap:true});
 const runs=ofKind('run');
 if(!runs.length)lines.push({text:L.none});
 for(const row of runs){const b=((row.content as {batch?:Record<string,unknown>}).batch??{});
  lines.push({text:fill(L.runLine,{runType:String(b.run_type??''),runSeq:String(b.run_seq??''),status:String(b.status??''),closedAt:iso(b.closed_at)||'-',releasedAt:iso(b.released_at)||'-'})});}
 lines.push({text:L.statutory,bold:true,gap:true});
 const reports=ofKind('statutory_file');
 if(!reports.length)lines.push({text:L.none});
 for(const row of reports){const c=row.content as {form?:string|null;report?:Record<string,unknown>};const r=c.report??{};
  lines.push({text:`${String(r.report_type??'')} (${c.form??'-'}) · ${String(r.status??'')} · ${iso(r.generated_at)}${r.ack_ref?` · ${String(r.ack_ref)}`:''}`});}
 for(const row of ofKind('bank_file')){const c=row.content as Record<string,unknown>;
  lines.push({text:`${String(c.format??'')} · ${String(c.bank??'-')} · ${String(c.recordCount??'')} · ${String(c.totalCents??'')} · sha256 ${String(c.fileSha256??'')}`});}
 const filing=ofKind('filing')[0]?.content as {evidence?:{what?:string;on?:string|null;reference?:string|null}[]}|undefined;
 lines.push({text:L.filingEvidence,bold:true,gap:true});
 if(!filing?.evidence?.length)lines.push({text:L.none});
 for(const item of filing?.evidence??[])lines.push({text:`${item.what??''} · ${item.on??'-'} · ${item.reference??'-'}`});
 lines.push({text:L.findings,bold:true,gap:true});
 if(!findings.length)lines.push({text:L.none});
 for(const control of AUDIT_CONTROL_IDS){
  const these=findingRows.filter(row=>row.controlId===control);if(!these.length)continue;
  const disposed=these.filter(row=>row.dispositions.length).length;
  lines.push({text:fill(L.findingLine,{control:L.controls[control],count:these.length,open:these.length-disposed,disposed})});
  for(const row of these){const last=row.dispositions.at(-1);
   lines.push({text:fill(L.findingItem,{control:L.controls[control],who:who(row.employmentId)??'-',state:last?L.dispositions[last.disposition]:L.open})});}
 }
 lines.push({text:L.corrections,bold:true,gap:true});
 const corrections=ofKind('correction');
 if(!corrections.length)lines.push({text:L.none});
 for(const row of corrections){const c=row.content as {statusHistory?:Record<string,unknown>;rootCauses?:{root_cause?:string;note?:string}[]};
  const cause=c.rootCauses?.at(-1);
  lines.push({text:fill(L.correctionLine,{action:String(c.statusHistory?.action??''),at:iso(c.statusHistory?.created_at),cause:cause?.root_cause??'-',note:cause?.note??'-'})});}
 lines.push({text:L.captures,bold:true,gap:true});
 for(const kind of AUDIT_CAPTURE_KINDS){const n=captures.filter(row=>row.kind===kind).length;if(n)lines.push({text:fill(L.captureLine,{kind:L.kinds[kind],count:n})});}
 lines.push({text:L.verification,bold:true,gap:true},{text:verification.valid?fill(L.verified,{count:verification.checked,head:verification.head??'-'})
  :fill(L.notVerified,{count:verification.issues.length})},
  {text:fill(L.anchors,{matched:verification.anchors.matched,chained:verification.anchors.inAuditChain})});
 const pdf=await summaryPdf(lines,count=>fill(L.unprintable,{count}));
 files.unshift({name:'summary.pdf',content:pdf.bytes});
 const listed:AuditPackFile[]=files.map(file=>Object.freeze({name:file.name,sha256:sha256Hex(file.content),bytes:file.content.byteLength}));
 const manifest={companyId:p.companyId,companyName:data.companyName,payPeriod:p.payPeriod,generatedAt:generatedAt.toISOString(),generatedBy:ctx.userId,
  captures:captures.length,chainHead:verification.head,verification:{valid:verification.valid,issues:verification.issues.length,anchors:verification.anchors},
  summary:{unprintableCharacters:pdf.unprintable},files:listed};
 const zip=new JSZip();
 for(const file of files)zip.file(file.name,file.content,{date:generatedAt});
 zip.file('manifest.json',json(manifest),{date:generatedAt});
 const bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
 const slug=data.companyName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'company';
 return Object.freeze({filename:`audit-pack-${slug}-${p.payPeriod}.zip`,bytes,sha256:sha256Hex(bytes),files:Object.freeze([...listed,
  Object.freeze({name:'manifest.json',sha256:sha256Hex(json(manifest)),bytes:new TextEncoder().encode(json(manifest)).byteLength})]),
  captures:captures.length,verification,companyName:data.companyName,unprintable:pdf.unprintable});
}

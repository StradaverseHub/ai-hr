/**
 * Saved Probation Evaluation Form (offline HTML, form v22.9.26) reader (handoff §5 Part C items 1-2).
 *
 * The offline form keeps every value in a JSON block, `<script id="form-data" type="application/json">`, which the page
 * applies by script when it opens. This reader treats the uploaded file as hostile data: it never renders, executes or
 * builds a DOM from it. It scans the markup only to find that one block (skipping comments and raw-text elements), parses
 * the JSON, and validates it with a strict schema. Anything else in the file is ignored.
 *
 * FIELD NAMES ARE INFERRED from the approved prototype's importer (`parseBlob`), not from a real saved file. Check a real
 * saved v22.9.26 file against `PROBATION_FORM_FIELDS` before go-live.
 */
import {z} from 'zod';
import {isCalendarDate} from './calendar-date';

export const PROBATION_FORM_VERSION='22.9.26';
export const PROBATION_FORM_MAX_BYTES=2*1024*1024;
export const PROBATION_FORM_MAX_FILES=50;

/** Criteria in the order the saved form lists them (A1, A2, B1-B7), mapped to the system's criterion ids. */
export const PROBATION_FORM_CRITERIA=[
 ['A1','kpi'],['A2','knowledge'],['B1','customer'],['B2','action'],['B3','standards'],['B4','positivity'],['B5','talent'],['B6','respect'],['B7','transparency'],
] as const;
/** Planned support boxes on Part 1, mapped to the system's planned-support fields. */
export const PROBATION_FORM_SUPPORT=[['sup1','coaching'],['sup2','access'],['sup3','checkins'],['sup4','other']] as const;

export type ImportedRating={rating:number|null;evidence:string};
export type ImportedSignature={role:'employee'|'lm'|'hod'|'pbp';name:string;date:string;drawn:boolean};
export type ImportedPartStatus='signed'|'started'|'not_started';
export type ImportedPart1={status:ImportedPartStatus;locked:boolean;signatures:ImportedSignature[];kpis:{accountability:string;measure:string;target:string;targetDate:string}[];support:{coaching:string;access:string;checkins:string;other:string};employeeComments:string};
export type ImportedReview={status:ImportedPartStatus;locked:boolean;signatures:ImportedSignature[];reviewOn:string;conductedBy:string;employee:Record<string,ImportedRating>;manager:Record<string,ImportedRating>;strengths:string;development:string;employeeComments:string;managerComments:string;midpointStatus:'satisfactory'|'development'|'at_risk'|null;outcome:'confirm'|'extend'|'not_confirm'|'other'|null;justification:string;otherOutcome:string};
export type ImportedProbationForm={
 formVersion:string;savedAt:string;
 employee:{name:string;id:string;title:string;grade:string;businessGroup:string;businessUnit:string;department:string;lineManager:string;joinedOn:string;probationFrom:string;probationTo:string};
 parts:{'1':ImportedPart1;'2':ImportedReview;'3':ImportedReview};
};
export type ProbationFormRefusal='file_type'|'empty'|'too_large'|'no_block'|'several_blocks'|'block_type'|'damaged'|'no_version'|'wrong_version'|'no_values'|'invalid_field'|'no_employee_id'|'no_employee_name';
export type ProbationFormParse=
 |{ok:true;form:ImportedProbationForm;warnings:string[]}
 |{ok:false;code:ProbationFormRefusal;message:string;version?:string;field?:string};

const RAW_TEXT=new Set(['script','style','textarea','title','xmp','iframe','noembed','noframes','noscript']);
type Block={type:string|null;text:string};

/** Attributes of one start tag's source (after the tag name), first occurrence wins as in HTML. */
function attributes(source:string):Map<string,string>{
 const out=new Map<string,string>(),re=/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
 for(let m=re.exec(source);m;m=re.exec(source)){const name=m[1].toLowerCase();if(!out.has(name))out.set(name,(m[2]??m[3]??m[4]??'').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&'));}
 return out;
}
/** End of a tag starting at `from` ('<'), honouring quoted attribute values; -1 when unterminated. */
function tagEnd(html:string,from:number):number{
 let quote='';for(let i=from+1;i<html.length;i++){const ch=html[i];if(quote){if(ch===quote)quote='';}else if(ch==='"'||ch==="'")quote=ch;else if(ch==='>')return i;}
 return -1;
}
/**
 * Every `<script id="form-data">` element in document order, skipping comments and the content of raw-text elements
 * (so a block quoted inside a comment, a textarea or another script is never read). Linear in the file size.
 */
export function formDataBlocks(html:string):Block[]{
 const blocks:Block[]=[],lower=html.toLowerCase();let i=0;
 while(i<html.length){
  const lt=html.indexOf('<',i);if(lt<0)break;
  if(html.startsWith('<!--',lt)){const end=html.indexOf('-->',lt+4);if(end<0)break;i=end+3;continue;}
  if(html[lt+1]==='!'||html[lt+1]==='?'){const end=html.indexOf('>',lt+2);if(end<0)break;i=end+1;continue;}
  const name=/^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt,lt+40));
  if(!name){i=lt+1;continue;}
  const end=tagEnd(html,lt);if(end<0)break;
  const tag=name[1].toLowerCase();
  // HTML ignores a self-closing slash on these elements: their content still runs to the end tag.
  if(RAW_TEXT.has(tag)){
   const close=lower.indexOf('</'+tag,end+1),content=html.slice(end+1,close<0?html.length:close);
   if(tag==='script'){const attrs=attributes(html.slice(lt+1+tag.length,end));if(attrs.get('id')==='form-data')blocks.push({type:attrs.has('type')?attrs.get('type')!.trim().toLowerCase():null,text:content});}
   if(close<0)break;i=close+2+tag.length;continue;
  }
  i=end+1;
 }
 return blocks;
}

const scalar=z.union([z.string().max(20000),z.number(),z.boolean(),z.null()]);
const blockSchema=z.object({
 formVersion:z.string().max(40).optional(),
 meta:z.object({savedAt:z.string().max(64).optional()}).loose().optional(),
 f:z.record(z.string().max(80),scalar).refine(value=>Object.keys(value).length<=600,'Too many fields').optional(),
 sigs:z.record(z.string().max(80),z.union([z.string().max(1_500_000),z.null()])).refine(value=>Object.keys(value).length<=20,'Too many signatures').optional(),
 locks:z.record(z.string().max(10),z.boolean()).optional(),
}).loose();

class FieldError extends Error{readonly field:string;constructor(field:string,message:string){super(message);this.field=field;}}
const norm=(value:unknown)=>typeof value==='string'||typeof value==='number'?String(value).replace(/ /g,' ').replace(/\s+/g,' ').trim():'';
const multiline=(value:unknown)=>typeof value==='string'||typeof value==='number'?String(value).replace(/ /g,' ').replace(/\r\n?/g,'\n').trim():'';

/** The saved form's values, read strictly: each known field has a type and a length bound; unknown fields are ignored. */
function reader(f:Record<string,unknown>){
 const has=(key:string)=>Object.hasOwn(f,key)&&f[key]!==null&&f[key]!=='';
 const text=(key:string,max=200)=>{if(!Object.hasOwn(f,key))return '';const v=f[key];if(v!==null&&typeof v!=='string'&&typeof v!=='number')throw new FieldError(key,'is not text');const out=norm(v);if(out.length>max)throw new FieldError(key,'is longer than '+max+' characters');return out;};
 const long=(key:string,max=5000)=>{if(!Object.hasOwn(f,key))return '';const v=f[key];if(v!==null&&typeof v!=='string'&&typeof v!=='number')throw new FieldError(key,'is not text');const out=multiline(v);if(out.length>max)throw new FieldError(key,'is longer than '+max+' characters');return out;};
 const date=(key:string)=>{const v=text(key,20);if(!v)return '';let m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v);const iso=m?v:(m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))?m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'):'';if(!iso||!isCalendarDate(iso))throw new FieldError(key,'is not a date (YYYY-MM-DD or D/M/YYYY)');return iso;};
 const rating=(key:string)=>{const v=text(key,2);if(!v)return null;if(!/^[1-5]$/.test(v))throw new FieldError(key,'is not a rating from 1 to 5');return Number(v);};
 const flag=(key:string)=>{if(!Object.hasOwn(f,key)||f[key]===null||f[key]==='')return false;const v=f[key];if(typeof v==='boolean')return v;if(v==='true'||v==='on')return true;if(v==='false')return false;throw new FieldError(key,'is not a tick box value');};
 const choice=<T extends string>(key:string,map:Record<string,T>):T|null=>{const v=text(key,40);if(!v)return null;if(!Object.hasOwn(map,v))throw new FieldError(key,'has an unknown choice “'+v.slice(0,40)+'”');return map[v];};
 return{has,text,long,date,rating,flag,choice};
}

/** Reads one saved form. Pure: no DOM, no network, no script. */
export function parseSavedProbationForm(input:{name:string;bytes:Uint8Array}):ProbationFormParse{
 if(!/\.html?$/i.test(input.name))return{ok:false,code:'file_type',message:'Only saved .html evaluation forms can be imported. Attach PDFs from the case or the intake review as evidence.'};
 if(input.bytes.byteLength<1)return{ok:false,code:'empty',message:'The file is empty.'};
 if(input.bytes.byteLength>PROBATION_FORM_MAX_BYTES)return{ok:false,code:'too_large',message:'The file is larger than 2 MB. A saved evaluation form is much smaller; check the file.'};
 const html=new TextDecoder('utf-8').decode(input.bytes);
 const blocks=formDataBlocks(html);
 if(!blocks.length)return{ok:false,code:'no_block',message:'The file has no saved values. Open the form and use “Save form” (not the browser’s Save page).'};
 if(blocks.length>1)return{ok:false,code:'several_blocks',message:'The file has more than one saved-values block, so it cannot be read safely.'};
 const block=blocks[0];
 if(block.type!==null&&block.type!=='application/json')return{ok:false,code:'block_type',message:'The saved-values block is not JSON, so it cannot be read safely.'};
 let raw:unknown;try{raw=JSON.parse(block.text.trim());}catch{return{ok:false,code:'damaged',message:'The saved values in the file are damaged and could not be read.'};}
 const parsed=blockSchema.safeParse(raw);
 if(!parsed.success)return{ok:false,code:'damaged',message:'The saved values in the file do not have the expected shape.'};
 const d=parsed.data,version=norm(d.formVersion);
 if(!version)return{ok:false,code:'no_version',message:'The file does not say which form version it is. Only form v'+PROBATION_FORM_VERSION+' can be imported.'};
 if(version!==PROBATION_FORM_VERSION)return{ok:false,code:'wrong_version',version,message:'This is form v'+version.slice(0,40)+'. Only form v'+PROBATION_FORM_VERSION+' can be imported; nothing was guessed.'};
 if(!d.f||!Object.keys(d.f).length)return{ok:false,code:'no_values',message:'The file has no saved values. Use “Save form” in the form itself.'};
 const warnings:string[]=[],sigs=d.sigs??{},locks=d.locks??{};
 try{
  const r=reader(d.f);
  const employee={name:r.text('emp_name'),id:r.text('emp_id',64),title:r.text('emp_title'),grade:r.text('emp_grade',40),businessGroup:r.text('emp_bg'),businessUnit:r.text('emp_bu'),department:r.text('emp_dept'),lineManager:r.text('emp_mgr'),joinedOn:r.date('emp_joined'),probationFrom:r.date('emp_prob_from'),probationTo:r.date('emp_prob_to')};
  if(!employee.id)return{ok:false,code:'no_employee_id',message:'The file has no employee ID, so it cannot be matched to an employee.'};
  if(!employee.name)return{ok:false,code:'no_employee_name',message:'The file has no employee name.'};
  const drawn=(...keys:string[])=>keys.some(key=>typeof sigs[key]==='string'&&sigs[key]!.length>0);
  const signature=(role:ImportedSignature['role'],prefix:string,image:string[]):ImportedSignature|null=>{const name=r.text(prefix+'_name'),date=r.date(prefix+'_date');return name&&date?{role,name,date,drawn:drawn(...image)}:null;};
  const list=(...items:(ImportedSignature|null)[])=>items.filter((s):s is ImportedSignature=>s!==null);
  // Part 1: the Week 1 Success Plan.
  const kpis=[];for(let i=1;i<=5;i++){const row={accountability:r.long('acc'+i+'_t',1000),measure:r.long('acc'+i+'_k',1000),target:r.long('acc'+i+'_g',1000),targetDate:r.date('acc'+i+'_d')};if(row.accountability||row.measure||row.target)kpis.push(row);}
  const support={coaching:'',access:'',checkins:'',other:''};
  for(const[key,field]of PROBATION_FORM_SUPPORT){const ticked=r.flag(key),detail=r.long(key+'_d',2000);if(ticked||detail)support[field]=detail||'Ticked on the imported form';}
  const p1sigs=list(signature('employee','p1_emp',['p1_emp']),signature('lm','p1_mgr',['p1_mgr'])),p1comments=r.long('p1_emp_comments');
  const p1Entered=kpis.length>0||Object.values(support).some(Boolean)||!!p1comments||p1sigs.length>0;
  const p1Full=p1sigs.length===2;
  const part1:ImportedPart1={status:locks.p1===true&&p1Full?'signed':p1Entered?'started':'not_started',locked:locks.p1===true,signatures:p1sigs,kpis,support,employeeComments:p1comments};
  if(locks.p1===true&&!p1Full)warnings.push('Part 1 is locked in the file but not every signature is filled in, so it opens as a draft.');
  // Parts 2 and 3: the reviews.
  const review=(n:2|3):ImportedReview=>{
   const p='p'+n+'_',employeeRatings:Record<string,ImportedRating>={},managerRatings:Record<string,ImportedRating>={};
   for(const[code,id]of PROBATION_FORM_CRITERIA){
    const er=r.rating(p+code+'_r'),mr=r.rating(p+code+'_mr'),ee=r.long(p+code+'_ev'),me=r.long(p+code+'_mev');
    if(er!==null||ee)employeeRatings[id]={rating:er,evidence:ee};
    if(mr!==null||me)managerRatings[id]={rating:mr,evidence:me};
   }
   const signatures=list(signature('employee',p+'emp',[p+'emp',p+'_emp']),signature('lm',p+'mgr',[p+'mgr',p+'_mgr']),...(n===3?[signature('hod','p3_hod',['p3_hod']),signature('pbp','p3_pp',['p3_pp'])]:[]));
   const part:ImportedReview={status:'not_started',locked:locks['p'+n]===true,signatures,reviewOn:r.date(p+'date'),conductedBy:r.text(p+'by'),employee:employeeRatings,manager:managerRatings,
    strengths:r.long(p+'strengths'),development:r.long(p+'devareas'),employeeComments:r.long(p+'empcomments'),managerComments:n===2?r.long('p2_mgrcomments'):'',
    midpointStatus:n===2?r.choice('p2_status',{satisfactory:'satisfactory',sat:'satisfactory',dev:'development',development:'development',risk:'at_risk',at_risk:'at_risk'}):null,
    outcome:n===3?r.choice('p3_decision',{confirm:'confirm',extend:'extend',nonconfirm:'not_confirm',not_confirm:'not_confirm',other:'other'}):null,
    justification:n===3?r.long('p3_justify'):'',otherOutcome:n===3?r.long('p3_decision_other',1000):''};
   const full=n===2?signatures.length===2:signatures.length===4;
   const entered=Object.keys(employeeRatings).length>0||Object.keys(managerRatings).length>0||!!part.reviewOn||!!part.strengths||!!part.development||!!part.employeeComments||!!part.managerComments||!!part.midpointStatus||!!part.outcome||!!part.justification||signatures.length>0;
   part.status=part.locked&&full?'signed':entered?'started':'not_started';
   if(part.locked&&!full)warnings.push('Part '+n+' is locked in the file but not every signature is filled in, so it opens as a draft.');
   return part;
  };
  const form:ImportedProbationForm={formVersion:version,savedAt:norm(d.meta?.savedAt).slice(0,64),employee,parts:{'1':part1,'2':review(2),'3':review(3)}};
  const drawnCount=Object.values(sigs).filter(v=>typeof v==='string'&&v.length>0).length;
  if(drawnCount)warnings.push(drawnCount+' hand-drawn signature'+(drawnCount===1?' is':'s are')+' kept only in the original file, never as an electronic signature.');
  return{ok:true,form,warnings};
 }catch(error){
  if(error instanceof FieldError)return{ok:false,code:'invalid_field',field:error.field.slice(0,80),message:'The field “'+error.field.slice(0,80)+'” '+error.message+'. Nothing was guessed; correct the form and save it again.'};
  throw error;
 }
}

/** One line per Part for the result list and the case history. */
export function importedFormSummary(form:ImportedProbationForm):{part:1|2|3;status:ImportedPartStatus;kpis?:number;managerRatings?:number;signatures:number;outcome?:string|null}[]{
 return[
  {part:1,status:form.parts['1'].status,kpis:form.parts['1'].kpis.length,signatures:form.parts['1'].signatures.length},
  ...([2,3] as const).map(n=>({part:n,status:form.parts[n].status,managerRatings:Object.values(form.parts[n].manager).filter(r=>r.rating!==null).length,signatures:form.parts[n].signatures.length,...(n===3?{outcome:form.parts['3'].outcome}:{})})),
 ];
}

// The saved offline Probation Evaluation Form reader (lane J, handoff §5 Part C): only the JSON in script#form-data is
// read, strictly, and the file is otherwise treated as data. Fixture: a synthetic, fictional v22.9.26 file whose field
// names are inferred from the prototype (test/fixtures/probation-saved-form-v22.9.26.html).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {formDataBlocks,importedFormSummary,parseSavedProbationForm,PROBATION_FORM_MAX_BYTES,PROBATION_FORM_VERSION} from '../lib/probation-intake-html';

const fixture=readFileSync(join(__dirname,'fixtures','probation-saved-form-v22.9.26.html'));
const bytes=(html:string)=>new TextEncoder().encode(html);
const saved=(data:unknown,attrs='type="application/json"')=>bytes('<!doctype html><html><body><h1>Probation Evaluation Form</h1><script id="form-data" '+attrs+'>'+JSON.stringify(data)+'</script></body></html>');
const minimal=(f:Record<string,unknown>,extra:Record<string,unknown>={})=>saved({formVersion:'22.9.26',f:{emp_name:'Fictional Ivy Ong',emp_id:'FX-30001',...f},...extra});
const parse=(name:string,content:Uint8Array)=>parseSavedProbationForm({name,bytes:content});

describe('a valid saved form',()=>{
 it('reads employee fields, KPIs, planned support, ratings and comments for both raters, dates, status and signatures',()=>{
  const result=parse('Aria Tan probation.html',fixture);
  if(!result.ok)throw new Error(result.message);
  const{form}=result;
  expect(form.formVersion).toBe(PROBATION_FORM_VERSION);
  expect(form.employee).toEqual({name:'Fictional Aria Tan',id:'FX-20001',title:'Fictional Analyst',grade:'JG 14',businessGroup:'Fictional Group',businessUnit:'Fictional Unit',department:'Fictional Department',lineManager:'Fictional Ben Lee',joinedOn:'2026-01-05',probationFrom:'2026-01-05',probationTo:'2026-07-04'});
  // Part 1: two KPI rows (a D/M/YYYY date becomes ISO), the ticked support boxes, and both signatures, so "signed".
  expect(form.parts['1'].kpis).toEqual([
   {accountability:'Close the monthly fictional ledger',measure:'Ledger closed with no open items',target:'By working day 5',targetDate:'2026-02-06'},
   {accountability:'Reconcile fictional suppliers',measure:'Reconciled accounts',target:'40 per month',targetDate:'2026-02-28'}]);
  expect(form.parts['1'].support).toEqual({coaching:'Weekly coaching with the Line Manager',access:'',checkins:'Ticked on the imported form',other:''});
  expect(form.parts['1'].signatures).toEqual([{role:'employee',name:'Fictional Aria Tan',date:'2026-01-09',drawn:true},{role:'lm',name:'Fictional Ben Lee',date:'2026-01-08',drawn:false}]);
  expect(form.parts['1'].status).toBe('signed');
  // Part 2: every criterion rated by both, the review date, the mid-probation status, signed and locked.
  expect(form.parts['2'].employee.kpi).toEqual({rating:4,evidence:'Closed four ledgers on time'});
  expect(form.parts['2'].manager.kpi).toEqual({rating:3,evidence:'On track'});
  expect(Object.keys(form.parts['2'].manager)).toHaveLength(9);
  expect(form.parts['2']).toMatchObject({reviewOn:'2026-04-03',conductedBy:'Fictional Ben Lee',midpointStatus:'satisfactory',managerComments:'Keep the pace',status:'signed'});
  // Part 3: started (ratings, no signatures, not locked); no outcome was chosen.
  expect(form.parts['3']).toMatchObject({status:'started',outcome:null,signatures:[]});
  expect(form.parts['3'].manager).toEqual({kpi:{rating:4,evidence:'Ledger closes consistently on day 4'}});
  expect(importedFormSummary(form)).toEqual([
   {part:1,status:'signed',kpis:2,signatures:2},{part:2,status:'signed',managerRatings:9,signatures:2},{part:3,status:'started',managerRatings:1,signatures:0,outcome:null}]);
  expect(result.warnings).toEqual(['1 hand-drawn signature is kept only in the original file, never as an electronic signature.']);
 });

 it('reads the outcome and the four Part 3 signatures, and a lock without every signature opens as a draft',()=>{
  const signed={p3_A1_mr:'2',p3_A1_mev:'Below target',p3_decision:'nonconfirm',p3_justify:'Targets missed',p3_emp_name:'Fictional Ivy Ong',p3_emp_date:'2026-07-01',p3_mgr_name:'Fictional Lead',p3_mgr_date:'2026-06-30',p3_hod_name:'Fictional Head',p3_hod_date:'2026-07-02',p3_pp_name:'Fictional Partner',p3_pp_date:'2026-07-03'};
  const full=parse('f.html',minimal(signed,{locks:{p3:true}}));
  expect(full.ok&&full.form.parts['3']).toMatchObject({status:'signed',outcome:'not_confirm',justification:'Targets missed'});
  expect(full.ok&&full.form.parts['3'].signatures.map(s=>s.role)).toEqual(['employee','lm','hod','pbp']);
  const partial=parse('f.html',minimal({...signed,p3_pp_name:'',p3_pp_date:''},{locks:{p3:true}}));
  expect(partial.ok&&partial.form.parts['3'].status).toBe('started');
  expect(partial.ok&&partial.warnings).toContain('Part 3 is locked in the file but not every signature is filled in, so it opens as a draft.');
 });
});

describe('refusals: nothing is guessed',()=>{
 it('refuses another form version, and a file that names no version',()=>{
  expect(parse('f.html',saved({formVersion:'22.9.25',f:{emp_id:'FX-1',emp_name:'Fictional'}}))).toMatchObject({ok:false,code:'wrong_version',version:'22.9.25'});
  expect(parse('f.html',saved({f:{emp_id:'FX-1',emp_name:'Fictional'}}))).toMatchObject({ok:false,code:'no_version'});
 });
 it('refuses a file without the saved-values block (a browser "Save page" copy), or with two of them',()=>{
  expect(parse('page.html',bytes('<html><body><input id="emp_id" value="FX-1"></body></html>'))).toMatchObject({ok:false,code:'no_block'});
  expect(parse('f.html',bytes('<script id="form-data" type="application/json">{}</script><script id=\'form-data\'>{}</script>'))).toMatchObject({ok:false,code:'several_blocks'});
  expect(parse('f.html',saved({formVersion:'22.9.26',f:{}}))).toMatchObject({ok:false,code:'no_values'});
 });
 it('refuses an oversized file before reading it, an empty file, and anything but .html',()=>{
  const big=new Uint8Array(PROBATION_FORM_MAX_BYTES+1);
  expect(parse('f.html',big)).toMatchObject({ok:false,code:'too_large'});
  expect(parse('f.html',new Uint8Array())).toMatchObject({ok:false,code:'empty'});
  expect(parse('signed.pdf',bytes('%PDF-1.7'))).toMatchObject({ok:false,code:'file_type'});
 });
 it('refuses damaged JSON, a non-JSON block type, an unreadable rating, date or choice, and a missing Employee ID',()=>{
  expect(parse('f.html',bytes('<script id="form-data" type="application/json">{"formVersion":</script>'))).toMatchObject({ok:false,code:'damaged'});
  expect(parse('f.html',saved({formVersion:'22.9.26',f:{emp_id:'FX-1',emp_name:'F'}},'type="text/javascript"'))).toMatchObject({ok:false,code:'block_type'});
  expect(parse('f.html',minimal({p2_A1_mr:'7'}))).toMatchObject({ok:false,code:'invalid_field',field:'p2_A1_mr'});
  expect(parse('f.html',minimal({emp_joined:'31/02/2026'}))).toMatchObject({ok:false,code:'invalid_field',field:'emp_joined'});
  expect(parse('f.html',minimal({p3_decision:'promote'}))).toMatchObject({ok:false,code:'invalid_field',field:'p3_decision'});
  expect(parse('f.html',minimal({emp_id:''}))).toMatchObject({ok:false,code:'no_employee_id'});
  expect(parse('f.html',saved({formVersion:'22.9.26',f:{emp_id:{nested:true},emp_name:'F'}}))).toMatchObject({ok:false,code:'damaged'});
 });
});

describe('hostile content stays data',()=>{
 it('never reads a block hidden in a comment or a textarea, and keeps an escaped end tag as text',()=>{
  const blocks=formDataBlocks(fixture.toString('utf8'));
  expect(blocks).toHaveLength(1);
  const result=parse('f.html',fixture);
  expect(result.ok&&result.form.parts['1'].employeeComments).toBe('I understand the plan </script> and the targets.');
 });
 it('treats markup and script in values as plain text, and never executes the page script',()=>{
  const attack='<img src=x onerror="globalThis.__probationPwned=1"><script>globalThis.__probationPwned=1</script>';
  const html='<html><body><script>globalThis.__probationPwned=1</script><script id="form-data" type="application/json">'+JSON.stringify({formVersion:'22.9.26',f:{emp_id:'FX-1',emp_name:'Fictional',p2_strengths:attack}}).replace(/<\//g,'<\\/')+'</script><img src=x onerror="globalThis.__probationPwned=1"></body></html>';
  const result=parse('f.html',bytes(html));
  expect(result.ok&&result.form.parts['2'].strengths).toBe(attack);
  expect((globalThis as {__probationPwned?:number}).__probationPwned).toBeUndefined();
 });
 it('ignores prototype keys and unknown fields instead of trusting them',()=>{
  const html='<script id="form-data" type="application/json">{"formVersion":"22.9.26","f":{"__proto__":"FX-EVIL","constructor":"FX-EVIL","emp_name":"Fictional","unknown":"x"}}</script>';
  expect(parse('f.html',bytes(html))).toMatchObject({ok:false,code:'no_employee_id'});
  expect(({} as Record<string,unknown>).emp_id).toBeUndefined();
 });
});

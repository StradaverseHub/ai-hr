import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {analyzePayFormula,applyFormulaAmount,evaluatePayFormula,parsePayFormula,printPayFormula,type FormulaRequest,type FormulaTraceEvent} from '../lib/pay-formula-language';
import {payFormulaFunction,PAY_FORMULA_FUNCTIONS,PAY_FORMULA_REGISTRY_VERSION} from '../lib/pay-formula-registry';
import {PAY_FORMULA_TEMPLATE_KEYS,payFormulaTemplateSource,isPayFormulaTemplateKey} from '../lib/pay-formula-templates';
import {diagnosePayFormula,formulaOffset,nearestFormulaName} from '../lib/pay-formula-diagnostics';
import {explainPayFormula} from '../lib/pay-formula-explain';
import {runPayFormulaSample} from '../lib/pay-formula-sample';
import {countsTowardFixedAllowances,resolvePayComponentSet,type ResolvablePayComponent} from '../core/pay-rule';
import {FIXTURES,resolveFixture} from './fixtures/pay-formula-regression';

const decimal=(value:string)=>({type:'decimal' as const,value});
const facts=(values:Record<string,string>)=>(request:FormulaRequest)=>{const value=values[request.code];if(value===undefined)throw Error('unavailable');return decimal(value);};
const words={and:'and',or:'or',not:'not',true:'True',false:'False',variable:(code:string)=>code};

describe('existing formulas are byte-identical (golden hashes captured at 2f6e5abe6)',()=>{
 const golden=['2749880c5bfdc7890d997acca695781a037adf1a28079a9e07e7d8fd80133a8c','05ef5f586e0811ea182901a136c7b9dafefe0c84a81bc5b900e1ecd866a16c92','1734c53a55efe10696d0658d3343e444763f55131e0fd1e7acb6c0b1700e225c','f83a52fe8299450186513fafbcec11abaa159ed70347ef55c26b7d6215adfcb6','67da306d57a18889361202f08ce77175a3a5d9bdcb283c844b7be5685755c681','90997396672a6d299718f95d50165ae284f743041885771e9164380016a0aea1','0d49d3e060ff109afb16e640aab73660dc57faf7fe73f810b2092d83e256c518','a46185bedd545775bee7575d53c8166a9bf86239183fde08f8375364c37284f2','7d54e16791dbe69e3f84b8ff3d1711daed5ec7cc8c73587727bb5cf59bf24648'];
 it.each(FIXTURES.map((source,index)=>[index,source] as const))('fixture %i parses, analyses, prints and evaluates exactly as before',(index,source)=>{
  const p=parsePayFormula(source),r=evaluatePayFormula(p,{resolve:resolveFixture});
  expect(createHash('sha256').update(JSON.stringify({p,a:analyzePayFormula(p),print:printPayFormula(p),r})).digest('hex')).toBe(golden[index]);
 });
 it('keeps the stored evaluator identity, so active revisions remain loadable',()=>{expect(PAY_FORMULA_REGISTRY_VERSION).toBe('payroll-formula-1');});
 it('an observing trace never changes the result',()=>{for(const source of FIXTURES){const p=parsePayFormula(source),events:FormulaTraceEvent[]=[];expect(evaluatePayFormula(p,{resolve:resolveFixture,trace:e=>events.push(e)})).toEqual(evaluatePayFormula(p,{resolve:resolveFixture}));expect(events.length).toBeGreaterThan(0);}});
});

describe('reference templates',()=>{
 const note='Hourly rate: ';
 it.each(PAY_FORMULA_TEMPLATE_KEYS.map(key=>[key]))('%s validates and round-trips through the Condition Builder printer',key=>{
  const source=payFormulaTemplateSource(key,note),program=parsePayFormula(source),printed=printPayFormula(program),again=parsePayFormula(printed);
  expect(printPayFormula(again)).toBe(printed);expect(diagnosePayFormula(source).filter(d=>d.severity==='error')).toEqual([]);
  for(const basic of ['3100','3500','4000','4500'])expect(evaluatePayFormula(again,{resolve:facts({Basic:basic,FixedAllowances:'300',CalendarDays:'31',Input:'10'})}).amount).toBe(evaluatePayFormula(program,{resolve:facts({Basic:basic,FixedAllowances:'300',CalendarDays:'31',Input:'10'})}).amount);
 });
 it('unpaid leave and absent: Basic 3,100, 31 days, 2 days = 200.00',()=>{
  for(const key of ['UNPAID_LEAVE','ABSENT'] as const){const result=evaluatePayFormula(parsePayFormula(payFormulaTemplateSource(key,note)),{resolve:facts({Basic:'3100',CalendarDays:'31',Input:'2'})});expect(applyFormulaAmount(result.amount)).toBe('200');}
 });
 it.each([['OT_1_5','1.5'],['OT_2_0','2'],['OT_3_0','3']] as const)('%s: (Basic + allowances) / 26 / 8 x rate x hours, independently computed',(key,rate)=>{
  const program=parsePayFormula(payFormulaTemplateSource(key,note));
  // Independent expectation: 3,800 x rate x 10 / 208, rounded half away from zero to cents.
  const expected=(Math.round(3800*Number(rate)*10/208*100)/100).toFixed(2).replace(/\.?0+$/,'');
  const result=evaluatePayFormula(program,{resolve:facts({Basic:'3500',FixedAllowances:'300',Input:'10'})});
  expect(applyFormulaAmount(result.amount)).toBe(expected);expect(result.explanations[0]).toMatch(/^Hourly rate: 18\.26923/);
  expect(evaluatePayFormula(program,{resolve:facts({Basic:'4000',FixedAllowances:'0',Input:'1'})}).amount).not.toBe('0');
  expect(evaluatePayFormula(program,{resolve:facts({Basic:'4500',FixedAllowances:'300',Input:'10'})}).amount).toBe('0');
 });
 it('OT 1.5 gives 274.04 for Basic 3,500, allowances 300 and 10 hours',()=>{expect(applyFormulaAmount(evaluatePayFormula(parsePayFormula(payFormulaTemplateSource('OT_1_5',note)),{resolve:facts({Basic:'3500',FixedAllowances:'300',Input:'10'})}).amount)).toBe('274.04');});
 it('escapes a translated note and only accepts known keys',()=>{expect(parsePayFormula(payFormulaTemplateSource('OT_2_0','Say "hi"\n'))).toBeTruthy();expect(isPayFormulaTemplateKey('OT_1_5')).toBe(true);expect(isPayFormulaTemplateKey('constructor')).toBe(false);});
});

describe('new variables',()=>{
 it('registers CalendarDays and FixedAllowances as Decimal variables without parameters',()=>{for(const code of ['CalendarDays','FixedAllowances'])expect(payFormulaFunction(code)).toMatchObject({code,returns:'decimal',parameters:[]});expect(PAY_FORMULA_FUNCTIONS.filter(fn=>fn.code==='FixedAllowances')).toHaveLength(1);});
 it('FixedAllowances membership is the legacy fixed_allowances membership on the same set',()=>{
  const comps:ResolvablePayComponent[]=[
   {code:'BASIC',kind:'allowance',rule:null,amount:3500},
   {code:'HOUSING',kind:'allowance',rule:null,amount:200,orpOvertime:true},
   {code:'MEAL',kind:'allowance',rule:{kind:'fixed'} as ResolvablePayComponent['rule'],amount:100,orpOvertime:true},
   {code:'UNTICKED',kind:'allowance',rule:null,amount:999,orpOvertime:false},
   {code:'BIK',kind:'allowance',rule:null,amount:50,orpOvertime:true,nonPayable:true},
   {code:'LOAN',kind:'deduction',rule:null,amount:70,orpOvertime:true},
   {code:'EPF_EE',kind:'contribution',rule:null,amount:10,orpOvertime:true},
   {code:'READER',kind:'earning',rule:{kind:'formula',start:{ref:'fixed_allowances'},terms:[]} as unknown as ResolvablePayComponent['rule'],amount:0,resolutionOrder:5},
  ];
  const legacy=resolvePayComponentSet(comps,{basic:3500,daysWorked:31,hours:0,components:{BASIC:3500}})[7];
  const pinned=new Set(['BASIC']),members=comps.filter(c=>countsTowardFixedAllowances(c,pinned));
  expect(members.map(c=>c.code)).toEqual(['HOUSING','MEAL']);expect(members.reduce((sum,c)=>sum+c.amount,0)).toBe(legacy);
  // Acyclic by construction: a rule-driven item (including any Formula Builder item) is never a member.
  expect(countsTowardFixedAllowances({code:'FB',kind:'allowance',rule:{kind:'formula_builder',formulaId:'X',dependencies:[]},orpOvertime:true},pinned)).toBe(false);
 });
});

describe('checks before saving',()=>{
 it('lists every problem with line, column and length, and suggests the nearest name',()=>{
  const source='Dim DailyRate As Decimal = {#Basic} / {#Input}\nIf {#Basic} <= 4000 Then\n    Return DailyRate * {#CalenderDays}\nEnd If';
  const found=diagnosePayFormula(source);
  expect(found).toEqual(expect.arrayContaining([
   expect.objectContaining({severity:'warning',code:'possible_zero_divisor',line:1,column:39,length:8,name:'{#Input}'}),
   expect.objectContaining({severity:'error',code:'unknown_function',line:3,column:24,length:15,name:'CalenderDays',suggestion:'CalendarDays'}),
   expect.objectContaining({severity:'error',code:'missing_return',line:2}),
  ]));
  expect(found.map(d=>[d.line,d.column])).toEqual([...found.map(d=>[d.line,d.column])].sort((a,b)=>a[0]-b[0]||a[1]-b[1]));
 });
 it('collects several statement problems instead of stopping at the first',()=>{
  const found=diagnosePayFormula('Dim A As Decimal = Bsic\nDim B As Decimal = "x"\nReturn A + {#Basicc}');
  expect(found.filter(d=>d.severity==='error').length).toBeGreaterThanOrEqual(3);
  expect(found.find(d=>d.code==='unknown_variable')).toMatchObject({line:1,column:20,name:'Bsic',suggestion:'{#Basic}'});
  expect(found.find(d=>d.code==='unknown_function')).toMatchObject({line:3,suggestion:'Basic'});
 });
 it('a plain or constant zero divisor is an error; CalendarDays and positive literals are not warned',()=>{
  expect(diagnosePayFormula('Return {#Basic} / 0')).toEqual([expect.objectContaining({severity:'error',code:'division_by_zero',line:1,column:19})]);
  expect(diagnosePayFormula('Return {#Basic} / (2 - 2)')[0]).toMatchObject({severity:'error',code:'division_by_zero'});
  expect(diagnosePayFormula('Return {#Basic} / {#CalendarDays} * 2 / 26')).toEqual([]);
 });
 it('warns for values derived from an input, and not once the divisor is guarded',()=>{
  expect(diagnosePayFormula('Dim Hours As Decimal = {#Input} * 1\nReturn 100 / Hours')).toEqual([expect.objectContaining({severity:'warning',name:'Hours',line:2})]);
  expect(diagnosePayFormula('If {#Input} > 0 Then\n Return 100 / {#Input}\nElse\n Return 0\nEnd If')).toEqual([]);
  expect(diagnosePayFormula('If {#Input} = 0 Then\n Return 0\nElse\n Return 100 / {#Input}\nEnd If')).toEqual([]);
  expect(diagnosePayFormula('If {#Input} = 0 Then\n Return 0\nEnd If\nReturn 100 / {#Input}')).toEqual([]);
 });
 it('runtime behaviour is unchanged: a zero input still stops at evaluation, not at parse',()=>{
  const program=parsePayFormula('Return 100 / {#Input}');expect(()=>evaluatePayFormula(program,{resolve:facts({Input:'0'})})).toThrow(/Division by zero/);
  expect(()=>parsePayFormula('Return 1 / 0')).not.toThrow();
 });
 it('maps positions to editor offsets and suggests only close names',()=>{expect(formulaOffset('ab\ncd',2,2)).toBe(4);expect(nearestFormulaName('CalenderDays',['CalendarDays','Basic'])).toBe('CalendarDays');expect(nearestFormulaName('Zzz',['CalendarDays'])).toBeUndefined();});
});

describe('plain-language explanation',()=>{
 it('is deterministic and follows the parsed structure',()=>{
  const program=parsePayFormula(payFormulaTemplateSource('OT_1_5','Hourly rate: '));
  const lines=explainPayFormula(program,words);expect(explainPayFormula(program,words)).toEqual(lines);
  expect(lines.map(l=>[l.depth,l.key])).toEqual([[0,'declare'],[0,'if'],[1,'explain'],[1,'return'],[0,'elseIf'],[1,'return'],[0,'otherwise'],[1,'return']]);
  expect(lines[0].values).toEqual({name:'Gross',expression:'Basic + FixedAllowances'});
  expect(lines[1].values.condition).toBe('Basic ≤ 4000');expect(lines[3].values.expression).toBe('Gross ÷ 26 ÷ 8 × 1.5 × Input');
  expect(explainPayFormula(parsePayFormula('Return 10 - (2 - 1)'),words)[0].values.expression).toBe('10 − (2 − 1)');
 });
});

describe('sample-value test',()=>{
 const ot=payFormulaTemplateSource('OT_1_5','Hourly rate: ');
 it('uses the payroll evaluator and cent step, with a step trace',()=>{
  const result=runPayFormulaSample(ot,{Basic:'3500',FixedAllowances:'300',CalendarDays:'31',Input:'10'});
  expect(result).toMatchObject({passed:true,payable:'274.04',error:null});expect(result.amount).toBe(evaluatePayFormula(parsePayFormula(ot),{resolve:facts({Basic:'3500',FixedAllowances:'300',Input:'10'})}).amount);
  expect(result.steps.map(s=>s.kind)).toEqual(expect.arrayContaining(['read','set','condition','arithmetic','explain','return']));
  expect(result.steps.find(s=>s.kind==='set')).toMatchObject({name:'Gross',value:{value:'3800'}});
 });
 it('never guesses: a missing typed value and a non-sample variable are named',()=>{
  expect(runPayFormulaSample(ot,{Basic:'3500',Input:'10'}).error).toMatchObject({code:'sample_missing',variable:'FixedAllowances',line:1});
  expect(runPayFormulaSample('Return {#PayItem}("HOUSING")',{Basic:'1'}).error).toMatchObject({code:'needs_employee_test',variable:'PayItem'});
  expect(runPayFormulaSample('Return 1',{Basic:'abc'}).error).toMatchObject({code:'sample_invalid',variable:'Basic'});
  expect(runPayFormulaSample('Return 1',{CalendarDays:'45'}).error).toMatchObject({code:'sample_invalid',variable:'CalendarDays'});
  expect(runPayFormulaSample('Return 100 / {#Input}',{Input:'0'}).error).toMatchObject({code:'division_by_zero',line:1});
  expect(runPayFormulaSample('Return {#Basic',{}).error).toMatchObject({code:'invalid_formula'});
 });
 it('applies the same Pay Item amount limits as payroll',()=>{expect(runPayFormulaSample('Return 0 - 1',{}).error?.code).toBe('out_of_range');});
});

import {describe,expect,it} from 'vitest';
import {PAY_FORMULA_VARIABLE_CATEGORIES,type FormulaValue} from '../lib/pay-formula-registry';
import {analyzePayFormula,applyFormulaAmount,divideFormulaDecimal,evaluatePayFormula,formulaDependencies,multiplyFormulaDecimal,normalizeFormulaDecimal,parsePayFormula,PayFormulaError,printPayFormula,roundFormulaDecimal,type FormulaProgram,type FormulaRequest} from '../lib/pay-formula-language';
const decimal=(value:string):FormulaValue=>({type:'decimal',value});
const text=(value:string):FormulaValue=>({type:'string',value});
const facts:Record<string,FormulaValue>={Basic:decimal('3000'),Accumulation:decimal('500'),Payrate:text('Monthly'),OrdinaryRate:decimal('26'),HoursPerDay:decimal('8'),Rate:decimal('1.5'),Input:decimal('10')};
const resolve=(request:FormulaRequest)=>{const value=facts[request.code];if(!value)throw Error('Unavailable');return value;};
const overtime=`Dim OTBasic As Decimal = {#Basic}
Dim OTGross As Decimal = {#Accumulation}("OT_GROSS")
Dim TotalGross As Decimal = OTBasic + OTGross
If TotalGross < 4000 Then
    {#Explain}("If Monthly Gross is less than RM4000")
    {#Explain}("Basic: " & OTBasic)
    {#Explain}("OT Allowances: " & OTGross)
Else
    {#Explain}("Gross for OT Calculation: 4000")
    TotalGross = 4000
End If
If {#Payrate} = "Monthly" Then
    {#Explain}("OT Amount = Total Gross / Ordinary Rate / HoursPerDay * OT Rate * Input Hour")
    {#Explain}("OT Amount = " & TotalGross & " / " & {#OrdinaryRate} & " / " & {#HoursPerDay} & " * " & {#Rate} & " * " & {#Input})
    Return TotalGross / {#OrdinaryRate} / {#HoursPerDay} * {#Rate} * {#Input}
Else
    {#Explain}("Payrate is not Monthly.")
    Return 0
End If`;
const semantic=(value:unknown):unknown=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='loc').map(([key,v])=>[key,semantic(v)])):value;
describe('one exact, bounded payroll formula language',()=>{
 it('runs the reporter overtime example with independent uncapped/capped expectations and retained explanations',()=>{
  const program=parsePayFormula(overtime),result=evaluatePayFormula(program,{resolve});
  expect(roundFormulaDecimal(result.amount,2)).toBe('252.4');
  expect(result.explanations).toContain('Basic: 3000');expect(result.explanations).toContain('OT Allowances: 500');
  expect(result.reads.find(r=>r.code==='Accumulation')?.args).toEqual([text('OT_GROSS')]);
  const capped=evaluatePayFormula(program,{resolve:request=>request.code==='Basic'?decimal('4500'):resolve(request)});
  expect(roundFormulaDecimal(capped.amount,2)).toBe('288.46');expect(capped.explanations).toContain('Gross for OT Calculation: 4000');
  const hourly=evaluatePayFormula(program,{resolve:request=>request.code==='Payrate'?text('Hourly'):resolve(request)});
  expect(hourly.amount).toBe('0');expect(hourly.explanations.at(-1)).toBe('Payrate is not Monthly.');expect(hourly.reads.some(r=>r.code==='Rate')).toBe(false);
 });
 it('rounds decimal ties away from zero, avoiding binary-float money and preserving configured payable rounding',()=>{
  expect(evaluatePayFormula(parsePayFormula('Return 0.1 + 0.2'),{resolve}).amount).toBe('0.3');
  expect(evaluatePayFormula(parsePayFormula('Return {#Rounding}(-1.005, 2)'),{resolve}).amount).toBe('-1.01');
  expect(roundFormulaDecimal('1.005',2)).toBe('1.01');expect(roundFormulaDecimal('-0.005',2)).toBe('-0.01');
  expect(normalizeFormulaDecimal('+00012.3400')).toBe('12.34');
  expect(multiplyFormulaDecimal('3000','0.5')).toBe('1500');expect(divideFormulaDecimal('1','3')).toBe('0.333333333333');
  expect(applyFormulaAmount('100',{factor:divideFormulaDecimal('1','3')})).toBe('33.33');
  expect(applyFormulaAmount('-1.495',{rounding:'nearest'})).toBe('-2');expect(applyFormulaAmount('-1.235',{rounding:'up'})).toBe('-1');expect(applyFormulaAmount('-1.235',{rounding:'down'})).toBe('-2');
 });
 it('round-trips every supported visual construct, typed names, nested conditions, ElseIf and comments through one tree',()=>{
  const source=`' Original purpose retained
Dim amount As Decimal = 10.05 ' Inline comment retained
Dim message As String = "A ""quoted"" amount: "
Dim eligible As Boolean = True
Dim joined As Date = {#EmployeeProfile}("groupJoinDate")
If eligible And joined <= {#Date}("2026-01-01") Then
    amount = {#Rounding}(amount / 3, 2)
    {#Explain}(message & amount)
ElseIf Not eligible Then
    amount = -1
Else
    If {#JoinedThisMonth} Then
        amount = 0
    Else
        amount = 2
    End If
End If
Return amount`;
  const program=parsePayFormula(source),printed=printPayFormula(program),again=parsePayFormula(printed);
  expect(semantic(again)).toEqual(semantic(program));expect(printed).toContain('Inline comment retained');expect(printed).toContain('ElseIf');
  const result=evaluatePayFormula(again,{resolve:request=>request.code==='EmployeeProfile'?{type:'date',value:'2025-01-01'}:{type:'boolean',value:false}});
  expect(result.amount).toBe('3.35');expect(result.explanations).toEqual(['A "quoted" amount: 3.35']);
 });
 it('publishes all fourteen categories and resolves typed source calls without arbitrary field paths',()=>{
  expect(PAY_FORMULA_VARIABLE_CATEGORIES).toHaveLength(14);
  const cases:[string,FormulaValue][]=[['{#PayItem}("A001")',decimal('12')],['{#PayItemNoProrate}("A001")',decimal('24')],['{#PayItemInput}("A001")',decimal('3')],['{#Basic}',decimal('3000')],['{#Input}',decimal('2')],['{#AnotherPayItems}("A001", "2026-01", "ME", "1")',decimal('55')],['{#ServiceLength}("months", "hiredOn")',decimal('18')]];
  for(const [expression,value]of cases)expect(evaluatePayFormula(parsePayFormula('Return '+expression),{resolve:()=>value}).amount).toBe(value.value);
  const mixed=parsePayFormula(`Dim info As String = {#EmployeeInformation}("gender")
Dim mode As String = {#InputType}
Dim joined As Date = {#JoinDate}
Dim groupDate As Date = {#GroupJoinDate}
Dim resigned As Date = {#ResignationDate}
If info = "female" And mode = "formula_builder" And joined >= groupDate And resigned > joined Then
 Return {#Rounding}({#Basic}, 0)
Else
 Return 0
End If`);
  const values:Record<string,FormulaValue>={EmployeeInformation:text('female'),InputType:text('formula_builder'),JoinDate:{type:'date',value:'2025-01-01'},GroupJoinDate:{type:'date',value:'2024-01-01'},ResignationDate:{type:'date',value:'2026-01-01'},Basic:decimal('3000')};
  expect(evaluatePayFormula(mixed,{resolve:r=>values[r.code]}).amount).toBe('3000');
 });
 it('extracts exact static dependencies for native cycle planning and permission-scoped source snapshots',()=>{
  const p=parsePayFormula(`Dim a As Decimal = {#PayItem}("a001") + {#PayItemNoProrate}("B002") + {#PayItemInput}("C003")
Return a + {#History}("H001", "2026-01", "ME", "2") + {#Accumulation}("OT_GROSS")`);
  expect(formulaDependencies(p).map(d=>[d.kind,d.code,d.parameters])).toEqual([['calculated','A001',[]],['unprorated','B002',[]],['input','C003',[]],['history','H001',['2026-01','ME','2']],['accumulation','OT_GROSS',[]]]);
  expect(analyzePayFormula(p).calls.map(r=>r.code)).toEqual(['PayItem','PayItemNoProrate','PayItemInput','AnotherPayItems','Accumulation']);
 });
 it('short-circuits unused provider reads without fabricating missing data',()=>{
  const p=parsePayFormula('If False And {#Basic} > 0 Then\n Return 1\nElse\n Return 2\nEnd If');
  expect(evaluatePayFormula(p,{resolve:()=>{throw Error('denied');}})).toMatchObject({amount:'2',reads:[]});
  expect(()=>evaluatePayFormula(parsePayFormula('Return {#Basic}'),{resolve:()=>{throw Error('denied');}})).toThrow(/unavailable or not permitted/);
  expect(()=>evaluatePayFormula(parsePayFormula('Return {#Basic}'),{resolve:()=>undefined as unknown as FormulaValue})).toThrow(/typed payroll value/);
  expect(()=>evaluatePayFormula(parsePayFormula('Return {#Basic}'),{resolve:()=>({type:'decimal',value:0.1} as unknown as FormulaValue)})).toThrow(/exact strings/);
 });
 it.each(['Return 1 / 0','Return 999999999999999999 + 1','Return 999999999999999999 * 2','Return 1.0000000000001','Return 1e3','Return "12"','Return {#Rounding}(1, 13)','Return {#EmployeeProfile}("bankAccount")','Dim item As String = "A001"\nReturn {#PayItem}(item)','Return {#AnotherPayItems}("A", "2026-99", "ME", "1")'])('blocks malformed or unsafe computation: %s',source=>{
  expect(()=>evaluatePayFormula(parsePayFormula(source),{resolve})).toThrow(PayFormulaError);
 });
 it.each(['Return eval("1")','Return {#require}("fs")','Return {#Basic}.constructor','While True\nReturn 1','Dim constructor As Decimal = 1\nReturn constructor','Return {#EmployeeInformation}("__proto__")'])('rejects unsupported language and injection: %s',source=>expect(()=>parsePayFormula(source)).toThrow(PayFormulaError));
 it('reports useful source locations and refuses incomplete or ill-typed paths',()=>{
  try{evaluatePayFormula(parsePayFormula('Dim x As Decimal = 1\nReturn x / 0'),{resolve});throw Error('did not refuse');}catch(error){expect(error).toBeInstanceOf(PayFormulaError);expect(error).toMatchObject({code:'division_by_zero',line:2,column:10});}
  expect(()=>parsePayFormula('If True Then\n Return 1\nEnd If')).toThrow(/Every formula path/);
  expect(()=>parsePayFormula('Dim x As Decimal = "no"\nReturn 1')).toThrow(/does not match/);
  expect(()=>parsePayFormula('If True Then\n Dim local As Decimal = 2\nEnd If\nReturn local')).toThrow(/not defined/);
 });
 it('enforces source, nesting, execution and explanation bounds for source and untrusted visual trees',()=>{
  expect(()=>parsePayFormula('Return '+ '('.repeat(30)+'1'+')'.repeat(30))).toThrow(/nesting/);
  expect(()=>parsePayFormula('Return 1\n'+' '.repeat(25000))).toThrow(/too long/);
  expect(()=>evaluatePayFormula(parsePayFormula('Return 1'),{resolve,limits:{steps:1}})).toThrow(/step limit/);
  expect(()=>evaluatePayFormula(parsePayFormula(Array.from({length:65},()=>'{#Explain}("x")').join('\n')+'\nReturn 1'),{resolve})).toThrow(/explanation output/);
  const malicious={version:1,statements:[{kind:'return',value:{kind:'binary',operator:'**',left:{kind:'literal',value:decimal('1')},right:{kind:'literal',value:decimal('2')}}}]} as unknown as FormulaProgram;
  expect(()=>evaluatePayFormula(malicious,{resolve})).toThrow(/Unknown binary operator/);
 });
});

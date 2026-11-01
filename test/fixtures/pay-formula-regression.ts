/** Formulas written with the vocabulary that existed before feedback 02472802 round 2. Their parse tree,
 * analysis, printed form and evaluation must stay byte-identical; golden hashes were captured from the
 * language/registry code at 2f6e5abe6098ab4e83ecd5fc95b4d6a580e7f308. */
type Value={type:'decimal';value:string}|{type:'string';value:string}|{type:'boolean';value:boolean}|{type:'date';value:string};
type Request={code:string;args:Value[]};
export const FIXTURES:readonly string[]=[
 `Dim OTBasic As Decimal = {#Basic}
Dim OTGross As Decimal = {#Accumulation}("OT_GROSS")
Dim TotalGross As Decimal = OTBasic + OTGross
If TotalGross < 4000 Then
    {#Explain}("Basic: " & OTBasic)
Else
    TotalGross = 4000
End If
If {#Payrate} = "Monthly" Then
    Return TotalGross / {#OrdinaryRate} / {#HoursPerDay} * {#Rate} * {#Input}
Else
    Return 0
End If`,
 `'Retained comment
Dim Amount As Decimal = 1.005
Dim Label As String = "Example"
Dim Eligible As Boolean = True
Dim Start As Date = {#Date}("2026-10-01")
If Eligible And Start <= {#JoinDate} Then
  If Amount > 0 Then
    Amount = {#Rounding}(Amount, 2)
  Else
    Amount = -1
  End If
ElseIf Not Eligible Then
  Amount = 2 * (3 + 1) / 2
Else
  Amount = 0
End If
{#Explain}(Label & " result")
Return Amount`,
 'Return {#Basic} / 10 + {#Input} * {#Rate}',
 'Return {#Rounding}(-1.005, 2)',
 'Return 0.1 + 0.2',
 'Return {#PayItem}("LOWER_A") + {#PayItemNoProrate}("LOWER_A") + {#PayItemInput}("LOWER_A")',
 'Return {#AnotherPayItems}("OT", "2026-04", "MONTHLY", "1") / 3',
 'If {#ServiceLength}("years", "hiredOn") >= 5 And {#JoinedThisMonth} = False Then\n Return {#Basic} * 0.1\nElse\n Return 0\nEnd If',
 '{#Explain}({#EmployeeInformation}("nationality"))\nReturn 1',
];
export function resolveFixture(request:Request):Value{
 switch(request.code){
  case 'Basic':return {type:'decimal',value:'3500'};
  case 'Accumulation':return {type:'decimal',value:'450.5'};
  case 'Payrate':return {type:'string',value:'Monthly'};
  case 'OrdinaryRate':return {type:'decimal',value:'26'};
  case 'HoursPerDay':return {type:'decimal',value:'8'};
  case 'Rate':return {type:'decimal',value:'1.5'};
  case 'Input':return {type:'decimal',value:'7.25'};
  case 'JoinDate':return {type:'date',value:'2024-02-29'};
  case 'PayItem':case 'PayItemNoProrate':case 'PayItemInput':return {type:'decimal',value:'123.456'};
  case 'AnotherPayItems':return {type:'decimal',value:'100'};
  case 'ServiceLength':return {type:'decimal',value:'6'};
  case 'JoinedThisMonth':return {type:'boolean',value:false};
  case 'EmployeeInformation':return {type:'string',value:'MY'};
  default:throw Error('Unavailable '+request.code);
 }
}

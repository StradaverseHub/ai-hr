/** Bounded payroll language shared by Write Formula, Condition Builder and real payroll.
 * Decimal values use 12 fractional / 18 integer digits. Multiplication and division round
 * intermediate results half away from zero at that explicit scale; no monetary float arithmetic. */
import {isCalendarDate} from './calendar-date';
import {PAY_FORMULA_FIELD_TYPES,PAY_FORMULA_REGISTRY_VERSION,payFormulaFunction,type FormulaType,type FormulaValue} from './pay-formula-registry';
export type {FormulaType,FormulaValue} from './pay-formula-registry';
export const PAY_FORMULA_EVALUATOR_VERSION='payroll-formula-1';
export const PAY_FORMULA_LIMITS={source:24000,tokens:6000,statements:512,nodes:3000,depth:24,steps:6000,explanations:64,explanationLength:12000,string:4096} as const;
export type FormulaLocation={line:number;column:number};
export class PayFormulaError extends Error {
 readonly line:number;readonly column:number;
 constructor(readonly code:string,message:string,loc:FormulaLocation={line:1,column:1}){super(`${message} (line ${loc.line}, column ${loc.column})`);this.name='PayFormulaError';this.line=loc.line;this.column=loc.column;}
}
const start={line:1,column:1};
function fail(code:string,message:string,loc:FormulaLocation=start):never{throw new PayFormulaError(code,message,loc);}
const Z=BigInt(0),O=BigInt(1),TEN=BigInt(10),SCALE=BigInt('1000000000000'),MAX=BigInt('999999999999999999999999999999');
const abs=(n:bigint)=>n<Z?-n:n;
function bounded(n:bigint,loc:FormulaLocation=start){if(abs(n)>MAX)fail('overflow','The decimal result exceeds 18 integer digits',loc);return n;}
function roundedDivision(n:bigint,d:bigint,loc:FormulaLocation=start){if(d===Z)fail('division_by_zero','Division by zero is not allowed',loc);const negative=(n<Z)!==(d<Z),a=abs(n),b=abs(d),q=a/b,r=a%b;return (negative?-O:O)*(q+(r*BigInt(2)>=b?O:Z));}
function decimal(text:string,loc:FormulaLocation=start):bigint{
 if(typeof text!=='string'||text.length>40||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))fail('decimal','An exact decimal string is required',loc);
 const negative=text.startsWith('-'),unsigned=text.replace(/^[-+]/,''),[whole='0',fraction='']=unsigned.split('.');
 if(fraction.length>12)fail('precision','Decimal values support at most 12 fractional digits',loc);
 return bounded((negative?-O:O)*(BigInt(whole||'0')*SCALE+BigInt((fraction+'000000000000').slice(0,12))),loc);
}
function decimalText(n:bigint){const a=abs(n),whole=a/SCALE,fraction=(a%SCALE).toString().padStart(12,'0').replace(/0+$/,'');return (n<Z?'-':'')+whole.toString()+(fraction?'.'+fraction:'');}
export function normalizeFormulaDecimal(value:string){return decimalText(decimal(value));}
export function addFormulaDecimal(a:string,b:string){return decimalText(bounded(decimal(a)+decimal(b)));}
export function multiplyFormulaDecimal(a:string,b:string){return decimalText(bounded(roundedDivision(decimal(a)*decimal(b),SCALE)));}
export function divideFormulaDecimal(a:string,b:string){return decimalText(bounded(roundedDivision(decimal(a)*SCALE,decimal(b))));}
export function roundFormulaDecimal(value:string,places=2){if(!Number.isInteger(places)||places<0||places>12)fail('precision','Rounding precision must be an integer from 0 to 12');const n=decimal(value),factor=TEN**BigInt(12-places);return decimalText(bounded(roundedDivision(n,factor)*factor));}
export type FormulaLiteral=Exclude<FormulaValue,{type:'date'}>;
export type FormulaExpression=
 |{kind:'literal';value:FormulaLiteral;loc:FormulaLocation}
 |{kind:'name';name:string;loc:FormulaLocation}
 |{kind:'call';code:string;args:FormulaExpression[];loc:FormulaLocation}
 |{kind:'unary';operator:'+'|'-'|'Not';operand:FormulaExpression;loc:FormulaLocation}
 |{kind:'binary';operator:string;left:FormulaExpression;right:FormulaExpression;loc:FormulaLocation};
export type FormulaStatement=
 |{kind:'declare';name:string;type:FormulaType;value:FormulaExpression;loc:FormulaLocation}
 |{kind:'assign';name:string;value:FormulaExpression;loc:FormulaLocation}
 |{kind:'if';branches:{condition:FormulaExpression;body:FormulaStatement[]}[];otherwise:FormulaStatement[];loc:FormulaLocation}
 |{kind:'return';value:FormulaExpression;loc:FormulaLocation}
 |{kind:'explain';value:FormulaExpression;loc:FormulaLocation}
 |{kind:'comment';text:string;loc:FormulaLocation};
export type FormulaProgram={version:1;statements:FormulaStatement[]};
export type FormulaRequest={code:string;args:FormulaValue[];loc:FormulaLocation};
export type FormulaDependency={kind:'calculated'|'unprorated'|'input'|'history'|'accumulation';code:string;parameters:string[];loc:FormulaLocation};
export type FormulaAnalysis={dependencies:FormulaDependency[];calls:FormulaRequest[];functions:string[];registryVersion:string;evaluatorVersion:string};
type Token={kind:'number'|'identifier'|'string'|'call'|'symbol'|'newline'|'comment'|'eof';text:string;loc:FormulaLocation};
function tokenize(source:string):Token[]{
 if(typeof source!=='string'||!source.trim())fail('source','Enter a formula');if(source.length>PAY_FORMULA_LIMITS.source)fail('limit','Formula source is too long');
 const out:Token[]=[];let i=0,line=1,column=1;
 const push=(kind:Token['kind'],text:string,loc:FormulaLocation)=>{out.push({kind,text,loc});if(out.length>PAY_FORMULA_LIMITS.tokens)fail('limit','Formula contains too many tokens',loc);};
 while(i<source.length){const loc={line,column},c=source[i];
  if(c===' '||c==='\t'){i++;column++;continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&source[i+1]==='\n')i++;i++;line++;column=1;push('newline','\n',loc);continue;}
  if(c==="'"){let value='';i++;column++;while(i<source.length&&!/[\r\n]/.test(source[i])){value+=source[i++];column++;}if(value.length>PAY_FORMULA_LIMITS.string)fail('limit','Comment is too long',loc);push('comment',value.trim(),loc);continue;}
  if(c==='"'){let value='',closed=false;i++;column++;while(i<source.length){if(source[i]==='"'){if(source[i+1]==='"'){value+='"';i+=2;column+=2;continue;}i++;column++;closed=true;break;}if(/[\r\n]/.test(source[i]))fail('string','A string must finish on the same line',loc);value+=source[i++];column++;if(value.length>PAY_FORMULA_LIMITS.string)fail('limit','String is too long',loc);}if(!closed)fail('string','Unterminated string',loc);push('string',value,loc);continue;}
  if(c==='{'){const m=/^\{#([A-Za-z][A-Za-z0-9_]*)\}/.exec(source.slice(i));if(!m)fail('token','Use an approved {#Variable} token',loc);push('call',m[1],loc);i+=m[0].length;column+=m[0].length;continue;}
  const n=/^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(i));if(n){push('number',n[0],loc);i+=n[0].length;column+=n[0].length;continue;}
  const name=/^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));if(name){if(name[0].length>64)fail('identifier','Variable name is too long',loc);push('identifier',name[0],loc);i+=name[0].length;column+=name[0].length;continue;}
  const op=/^(?:<=|>=|<>|[()+\-*/=&,< >])/.exec(source.slice(i));if(op){push('symbol',op[0],loc);i+=op[0].length;column+=op[0].length;continue;}
  fail('token',`Unsupported character ${JSON.stringify(c)}`,loc);
 }
 out.push({kind:'eof',text:'',loc:{line,column}});return out;
}
const precedence:Readonly<Record<string,number>>={Or:1,And:2,'=':3,'<>':3,'<':3,'<=':3,'>':3,'>=':3,'&':4,'+':5,'-':5,'*':6,'/':6};
const reserved=new Set(['dim','as','if','then','elseif','else','end','return','and','or','not','true','false','decimal','string','boolean','date','constructor','prototype','__proto__']);
function validName(name:unknown,loc:FormulaLocation){if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)||reserved.has(name.toLowerCase()))fail('identifier','Choose a non-reserved variable name',loc);return name;}
class Parser{
 private index=0;private depth=0;private count=0;
 constructor(private tokens:Token[]){}
 private token(){return this.tokens[this.index];}private next(){return this.tokens[this.index++];}
 private is(text:string){return this.token().text.toLowerCase()===text.toLowerCase();}
 private expect(text:string){const t=this.next();if(t.text.toLowerCase()!==text.toLowerCase())fail('syntax',`Expected ${text}`,t.loc);return t;}
 private lineEnd(){if(!['newline','eof','comment'].includes(this.token().kind))fail('syntax','Expected the end of the statement',this.token().loc);}
 private newlines(){while(this.token().kind==='newline')this.next();}
 private expression(min=0):FormulaExpression{
  if(++this.depth>PAY_FORMULA_LIMITS.depth)fail('limit','Expression nesting is too deep',this.token().loc);
  const t=this.next();let left:FormulaExpression;
  if(t.kind==='number')left={kind:'literal',value:{type:'decimal',value:decimalText(decimal(t.text,t.loc))},loc:t.loc};
  else if(t.kind==='string')left={kind:'literal',value:{type:'string',value:t.text},loc:t.loc};
  else if(t.text==='('){left=this.expression();this.expect(')');}
  else if(t.text==='+'||t.text==='-'||t.text.toLowerCase()==='not')left={kind:'unary',operator:t.text.toLowerCase()==='not'?'Not':t.text as '+'|'-',operand:this.expression(t.text.toLowerCase()==='not'?3:7),loc:t.loc};
  else if(t.kind==='identifier'&&['true','false'].includes(t.text.toLowerCase()))left={kind:'literal',value:{type:'boolean',value:t.text.toLowerCase()==='true'},loc:t.loc};
  else if(t.kind==='identifier')left={kind:'name',name:validName(t.text,t.loc),loc:t.loc};
  else if(t.kind==='call'){const fn=payFormulaFunction(t.text);if(!fn)fail('function',`Unsupported payroll function ${t.text}`,t.loc);const args:FormulaExpression[]=[];if(this.is('(')){this.next();if(!this.is(')')){do{args.push(this.expression());if(!this.is(','))break;this.next();}while(true);}this.expect(')');}left={kind:'call',code:fn.code,args,loc:t.loc};}
  else fail('syntax','Expected a value, variable or approved function',t.loc);
  while(true){const candidate=this.token(),operator=['and','or'].includes(candidate.text.toLowerCase())?candidate.text[0].toUpperCase()+candidate.text.slice(1).toLowerCase():candidate.text,p=precedence[operator];if(p===undefined||p<min)break;this.next();left={kind:'binary',operator,left,right:this.expression(p+1),loc:candidate.loc};}
  this.depth--;return left;
 }
 private block(stops:string[]=[]):FormulaStatement[]{const body:FormulaStatement[]=[];this.newlines();while(this.token().kind!=='eof'&&!stops.some(s=>this.is(s))){if(++this.count>PAY_FORMULA_LIMITS.statements)fail('limit','Too many formula statements',this.token().loc);body.push(this.statement());if(this.token().kind==='comment')body.push({kind:'comment',text:this.next().text,loc:this.tokens[this.index-1].loc});this.lineEnd();this.newlines();}return body;}
 private statement():FormulaStatement{
  const t=this.next(),word=t.text.toLowerCase();
  if(t.kind==='comment')return {kind:'comment',text:t.text,loc:t.loc};
  if(word==='dim'){const name=this.next();if(name.kind!=='identifier')fail('identifier','A variable name is required',name.loc);validName(name.text,name.loc);this.expect('As');const typeToken=this.next(),type=typeToken.text.toLowerCase();if(!['decimal','string','boolean','date'].includes(type))fail('type','Use Decimal, String, Boolean or Date',typeToken.loc);this.expect('=');return {kind:'declare',name:name.text,type:type as FormulaType,value:this.expression(),loc:t.loc};}
  if(word==='return')return {kind:'return',value:this.expression(),loc:t.loc};
  if(t.kind==='call'&&word==='explain'){this.expect('(');const value=this.expression();this.expect(')');return {kind:'explain',value,loc:t.loc};}
  if(word==='if'){
   const condition=this.expression();this.expect('Then');this.lineEnd();const headerComment=this.token().kind==='comment'?this.next():null;this.newlines();
   const firstBody=this.block(['ElseIf','Else','End']);if(headerComment)firstBody.unshift({kind:'comment',text:headerComment.text,loc:headerComment.loc});
   const branches=[{condition,body:firstBody}];
   while(this.is('ElseIf')){this.next();const condition=this.expression();this.expect('Then');this.lineEnd();const comment=this.token().kind==='comment'?this.next():null;this.newlines();const body=this.block(['ElseIf','Else','End']);if(comment)body.unshift({kind:'comment',text:comment.text,loc:comment.loc});branches.push({condition,body});}
   let otherwise:FormulaStatement[]=[];if(this.is('Else')){this.next();this.lineEnd();const comment=this.token().kind==='comment'?this.next():null;this.newlines();otherwise=this.block(['End']);if(comment)otherwise.unshift({kind:'comment',text:comment.text,loc:comment.loc});}
   this.expect('End');this.expect('If');return {kind:'if',branches,otherwise,loc:t.loc};
  }
  if(t.kind==='identifier'){const name=validName(t.text,t.loc);this.expect('=');return {kind:'assign',name,value:this.expression(),loc:t.loc};}
  fail('statement','Use a declaration, assignment, condition, explanation or return',t.loc);
 }
 parse():FormulaProgram{const program:FormulaProgram={version:1,statements:this.block()};if(this.token().kind!=='eof')fail('syntax','Unexpected statement terminator',this.token().loc);return program;}
}
export function parsePayFormula(source:string):FormulaProgram{const program=new Parser(tokenize(source)).parse();validatePayFormula(program);return program;}
export function applyFormulaAmount(amount:string,options:{factor?:string;rounding?:'none'|'up'|'down'|'nearest'}={}):string{
 let n=decimal(multiplyFormulaDecimal(amount,options.factor??'1'));n=roundedDivision(n,TEN**BigInt(10))*TEN**BigInt(10);
 const whole=n/SCALE,remainder=n%SCALE;
 if(options.rounding==='up')n=(whole+(remainder>Z?O:Z))*SCALE;
 else if(options.rounding==='down')n=(whole-(remainder<Z?O:Z))*SCALE;
 else if(options.rounding==='nearest')n=roundedDivision(n,SCALE)*SCALE;
 else if(options.rounding!==undefined&&options.rounding!=='none')fail('rounding','Unknown payable-amount rounding method');
 return decimalText(bounded(n));
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function location(value:unknown):FormulaLocation{if(!object(value)||!Number.isInteger(value.line)||!Number.isInteger(value.column)||Number(value.line)<1||Number(value.column)<1)return start;return {line:Number(value.line),column:Number(value.column)};}
function valueOf(value:unknown,loc:FormulaLocation):FormulaValue{
 if(!object(value))fail('value','A typed payroll value is required',loc);
 if(value.type==='decimal'){if(typeof value.value!=='string')fail('value','Decimal source values must be exact strings',loc);return {type:'decimal',value:decimalText(decimal(value.value,loc))};}
 if(value.type==='boolean'&&typeof value.value==='boolean')return {type:'boolean',value:value.value};
 if(value.type==='string'&&typeof value.value==='string'){if(value.value.length>PAY_FORMULA_LIMITS.string)fail('limit','String value is too long',loc);return {type:'string',value:value.value};}
 if(value.type==='date'&&typeof value.value==='string'&&isCalendarDate(value.value))return {type:'date',value:value.value};
 fail('value','The payroll source returned a missing, malformed or unsupported value',loc);
}
function literalValue(expression:FormulaExpression|undefined):FormulaValue|undefined{return expression?.kind==='literal'?expression.value:undefined;}
function fieldType(code:string,field:string){return PAY_FORMULA_FIELD_TYPES[code==='EmployeeProfile'?'profile':'employee'][field];}
function callType(expression:Extract<FormulaExpression,{kind:'call'}>,types:FormulaType[]):FormulaType{
 const fn=payFormulaFunction(expression.code),loc=expression.loc;if(!fn)fail('function',`Unsupported payroll function ${expression.code}`,loc);
 const required=fn.parameters.filter(p=>!p.optional).length;
 if(expression.args.length<required||expression.args.length>fn.parameters.length)fail('parameter',`${fn.code} requires ${required===fn.parameters.length?required:`${required}–${fn.parameters.length}`} parameter(s)`,loc);
 fn.parameters.forEach((parameter,i)=>{if(i>=types.length)return;const literal=literalValue(expression.args[i]);
  if(types[i]!==parameter.type)fail('type',`${fn.code}: ${parameter.name} must be ${parameter.type}`,expression.args[i].loc);
  if(parameter.literal&&!literal)fail('parameter',`${fn.code}: ${parameter.name} must be a literal value`,expression.args[i].loc);
  if(parameter.choices&&(!literal||!parameter.choices.includes(String(literal.value))))fail('parameter',`${fn.code}: choose a supported ${parameter.name}`,expression.args[i].loc);
 });
 const first=literalValue(expression.args[0]);
 if(['PayItem','PayItemNoProrate','PayItemInput','Accumulation','AnotherPayItems'].includes(fn.code)&&(!first||typeof first.value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(first.value)))fail('parameter',`${fn.code}: an exact configured code is required`,loc);
 if(fn.code==='AnotherPayItems'){
  const args=expression.args.map(literalValue);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(args[1]?.value)))fail('parameter','Historical period must be YYYY-MM',loc);
  if(!/^[A-Za-z0-9_.-]{1,80}$/.test(String(args[2]?.value)))fail('parameter','An exact payroll cycle code or ID is required',loc);
  if(!/^[1-9]\d{0,8}$/.test(String(args[3]?.value)))fail('parameter','Historical run reference must be its positive run sequence',loc);
 }
 if(fn.code==='Rounding'&&expression.args.length===2){const n=literalValue(expression.args[1]);if(n?.type!=='decimal'||!/^\d+$/.test(n.value)||Number(n.value)>12)fail('precision','Rounding precision must be a literal integer from 0 to 12',loc);}
 if(fn.code==='Date'&&(!first||typeof first.value!=='string'||!isCalendarDate(first.value)))fail('date','Use a real ISO calendar date',loc);
 return fn.returns==='field'?fieldType(fn.code,String(first?.value)):fn.returns;
}
/** Validates untrusted visual-editor ASTs as strictly as written source. No executable values enter it. */
export function validatePayFormula(program:unknown):FormulaAnalysis{
 if(!object(program)||program.version!==1||!Array.isArray(program.statements)||!program.statements.length)fail('program','A version 1 formula with statements is required');
 let nodes=0,statements=0;const dependencies:FormulaDependency[]=[],calls:FormulaRequest[]=[],functions=new Set<string>();
 const tick=(depth:number,loc:FormulaLocation)=>{if(++nodes>PAY_FORMULA_LIMITS.nodes||depth>PAY_FORMULA_LIMITS.depth)fail('limit','Formula structure exceeds its bounded size or depth',loc);};
 const infer=(raw:unknown,scope:Map<string,FormulaType>,depth:number):FormulaType=>{
  const loc=location(object(raw)?raw.loc:null);tick(depth,loc);if(!object(raw))fail('expression','A formula expression is required',loc);
  const expression=raw as unknown as FormulaExpression;
  switch(expression.kind){
   case 'literal':{const v=valueOf(expression.value,loc);if(v.type==='date')fail('date','Use the Date function for a date literal',loc);return v.type;}
   case 'name':{const name=validName(expression.name,loc),type=scope.get(name.toLowerCase());if(!type)fail('identifier',`Variable ${name} is not defined in this scope`,loc);return type;}
   case 'unary':{if(!['+','-','Not'].includes(expression.operator))fail('operator','Unknown unary operator',loc);const type=infer(expression.operand,scope,depth+1),expected=expression.operator==='Not'?'boolean':'decimal';if(type!==expected)fail('type',`${expression.operator} needs a ${expected} value`,loc);return expected;}
   case 'binary':{if(!Object.hasOwn(precedence,expression.operator))fail('operator','Unknown binary operator',loc);const left=infer(expression.left,scope,depth+1),right=infer(expression.right,scope,depth+1);
    if(expression.operator==='&')return 'string';
    if(['And','Or'].includes(expression.operator)){if(left!=='boolean'||right!=='boolean')fail('type','And/Or require Boolean operands',loc);return 'boolean';}
    if(['+','-','*','/'].includes(expression.operator)){if(left!=='decimal'||right!=='decimal')fail('type','Arithmetic requires Decimal operands',loc);return 'decimal';}
    if(left!==right)fail('type','Comparison operands must have the same type',loc);if(left==='boolean'&&!['=','<>'].includes(expression.operator))fail('type','Boolean values support equality comparisons only',loc);return 'boolean';}
   case 'call':{
    if(typeof expression.code!=='string'||!Array.isArray(expression.args))fail('function','A supported payroll function is required',loc);
    const types=expression.args.map(arg=>infer(arg,scope,depth+1)),type=callType(expression,types),fn=payFormulaFunction(expression.code)!;functions.add(fn.code);
    const literals=expression.args.map(literalValue);
    if(!['Rounding','Date'].includes(fn.code)){
     // Every external provider parameter is literal: no dynamic employee-field or item lookup.
     if(literals.some(value=>value===undefined))fail('parameter','Payroll source parameters must be literal values',loc);
     const request:FormulaRequest={code:fn.code,args:literals as FormulaValue[],loc};calls.push(request);
    }
    const kinds:Record<string,FormulaDependency['kind']>={PayItem:'calculated',PayItemNoProrate:'unprorated',PayItemInput:'input',AnotherPayItems:'history',Accumulation:'accumulation'};
    if(kinds[fn.code])dependencies.push({kind:kinds[fn.code],code:String(literals[0]!.value).toUpperCase(),parameters:literals.slice(1).map(value=>String(value!.value)),loc});
    return type;
   }
   default:fail('expression','Unknown formula expression',loc);
  }
 };
 const block=(raw:unknown,scope:Map<string,FormulaType>,depth:number):boolean=>{
  if(!Array.isArray(raw))fail('statement','A statement list is required');let returned=false;
  for(const entry of raw){const loc=location(object(entry)?entry.loc:null);tick(depth,loc);if(++statements>PAY_FORMULA_LIMITS.statements)fail('limit','Too many formula statements',loc);if(!object(entry))fail('statement','A statement is required',loc);const statement=entry as unknown as FormulaStatement;
   if(returned&&statement.kind!=='comment')fail('unreachable','This statement follows an unconditional return',loc);
   switch(statement.kind){
    case 'comment':if(typeof statement.text!=='string'||statement.text.length>PAY_FORMULA_LIMITS.string||/[\r\n]/.test(statement.text))fail('comment','A comment must fit on one bounded line',loc);break;
    case 'declare':{const name=validName(statement.name,loc).toLowerCase();if(scope.has(name))fail('identifier','Variable is already declared in this scope',loc);if(!['decimal','string','boolean','date'].includes(statement.type))fail('type','Unknown declaration type',loc);if(infer(statement.value,scope,depth+1)!==statement.type)fail('type','Declaration value does not match its type',loc);scope.set(name,statement.type);break;}
    case 'assign':{const name=validName(statement.name,loc).toLowerCase(),type=scope.get(name);if(!type)fail('identifier','Assign only to a previously declared variable',loc);if(infer(statement.value,scope,depth+1)!==type)fail('type','Assignment value does not match its declaration',loc);break;}
    case 'explain':infer(statement.value,scope,depth+1);break;
    case 'return':if(infer(statement.value,scope,depth+1)!=='decimal')fail('return','A payroll formula must return a Decimal amount',loc);returned=true;break;
    case 'if':{if(!Array.isArray(statement.branches)||!statement.branches.length||statement.branches.length>64||!Array.isArray(statement.otherwise))fail('condition','A bounded condition and branch list is required',loc);let all=true;
     for(const branch of statement.branches){if(!object(branch))fail('condition','A condition branch is required',loc);if(infer(branch.condition,scope,depth+1)!=='boolean')fail('type','If/ElseIf needs a Boolean condition',loc);if(!block(branch.body,new Map(scope),depth+1))all=false;}
     const elseReturns=block(statement.otherwise,new Map(scope),depth+1);returned=all&&elseReturns;break;}
    default:fail('statement','Unknown formula statement',loc);
   }
  }return returned;
 };
 if(!block(program.statements,new Map(),0))fail('return','Every formula path must return a Decimal amount');
 return {dependencies,calls,functions:[...functions].sort(),registryVersion:PAY_FORMULA_REGISTRY_VERSION,evaluatorVersion:PAY_FORMULA_EVALUATOR_VERSION};
}
export const analyzePayFormula=validatePayFormula;
export function formulaDependencies(program:FormulaProgram):FormulaDependency[]{return validatePayFormula(program).dependencies;}
function quoted(value:string){return '"'+value.replaceAll('"','""')+'"';}
/** Prints every typed construct, including comments; original authored source remains revision metadata. */
export function printPayFormula(program:FormulaProgram):string{
 validatePayFormula(program);
 const expression=(e:FormulaExpression):string=>{switch(e.kind){case 'literal':return e.value.type==='decimal'?normalizeFormulaDecimal(e.value.value):e.value.type==='boolean'?(e.value.value?'True':'False'):quoted(e.value.value);case 'name':return e.name;case 'call':return '{#'+payFormulaFunction(e.code)!.code+'}'+(e.args.length?'('+e.args.map(expression).join(', ')+')':'');case 'unary':return '('+e.operator+(e.operator==='Not'?' ':'')+expression(e.operand)+')';case 'binary':return '('+expression(e.left)+' '+e.operator+' '+expression(e.right)+')';}};
 const block=(statements:FormulaStatement[],indent:string):string[]=>statements.flatMap(s=>{switch(s.kind){case 'comment':return [indent+"' "+s.text];case 'declare':return [indent+'Dim '+s.name+' As '+s.type[0].toUpperCase()+s.type.slice(1)+' = '+expression(s.value)];case 'assign':return [indent+s.name+' = '+expression(s.value)];case 'return':return [indent+'Return '+expression(s.value)];case 'explain':return [indent+'{#Explain}('+expression(s.value)+')'];case 'if':{const lines:string[]=[];s.branches.forEach((b,i)=>{lines.push(indent+(i?'ElseIf ':'If ')+expression(b.condition)+' Then',...block(b.body,indent+'    '));});if(s.otherwise.length)lines.push(indent+'Else',...block(s.otherwise,indent+'    '));lines.push(indent+'End If');return lines;}}});
 return block(program.statements,'').join('\n');
}
export type FormulaEvaluation={amount:string;explanations:string[];reads:(FormulaRequest&{value:FormulaValue})[];steps:number;registryVersion:string;evaluatorVersion:string};
export type FormulaRuntime={resolve:(request:FormulaRequest)=>FormulaValue;limits?:Partial<{steps:number;explanations:number;explanationLength:number;reads:number;readLength:number}>};
function display(value:FormulaValue){return value.type==='boolean'?(value.value?'True':'False'):value.value;}
/** All external facts are pre-resolved by the authorized payroll adapter, never loaded by this engine. */
export function evaluatePayFormula(program:FormulaProgram,runtime:FormulaRuntime):FormulaEvaluation{
 validatePayFormula(program);if(!runtime||typeof runtime.resolve!=='function')fail('source','An authorized payroll source resolver is required');
 const maxima={steps:PAY_FORMULA_LIMITS.steps,explanations:PAY_FORMULA_LIMITS.explanations,explanationLength:PAY_FORMULA_LIMITS.explanationLength,reads:512,readLength:24000};
 const limits:Record<keyof typeof maxima,number>={...maxima};for(const key of Object.keys(maxima) as (keyof typeof maxima)[]){const proposed=runtime.limits?.[key];if(proposed!==undefined){if(!Number.isInteger(proposed)||proposed<1||proposed>maxima[key])fail('limit','Runtime limits may only narrow the bounded engine limits');limits[key]=proposed;}}
 let steps=0,textLength=0,readLength=0;const explanations:string[]=[],reads:FormulaEvaluation['reads']=[];
 const step=(loc:FormulaLocation)=>{if(++steps>limits.steps)fail('limit','Formula execution exceeded its step limit',loc);};
 type Cell={type:FormulaType;value:FormulaValue};type Environment=Map<string,Cell>;
 const expression=(e:FormulaExpression,env:Environment):FormulaValue=>{
  step(e.loc);
  switch(e.kind){
   case 'literal':return valueOf(e.value,e.loc);
   case 'name':{const value=env.get(e.name.toLowerCase());if(!value)fail('identifier',`Variable ${e.name} is unavailable`,e.loc);return value.value;}
   case 'unary':{const operand=expression(e.operand,env);if(e.operator==='Not'){if(operand.type!=='boolean')fail('type','Not requires a Boolean',e.loc);return {type:'boolean',value:!operand.value};}if(operand.type!=='decimal')fail('type','Signed values must be Decimal',e.loc);const n=decimal(operand.value,e.loc);return {type:'decimal',value:decimalText(e.operator==='-'?-n:n)};}
   case 'binary':{
    const left=expression(e.left,env);
    if(e.operator==='And'||e.operator==='Or'){
     if(left.type!=='boolean')fail('type','Logical operations require Boolean values',e.loc);
     if(e.operator==='And'&&!left.value||e.operator==='Or'&&left.value)return left;
     const right=expression(e.right,env);if(right.type!=='boolean')fail('type','Logical operations require Boolean values',e.loc);return right;
    }
    const right=expression(e.right,env);
    if(e.operator==='&'){const text=display(left)+display(right);if(text.length>PAY_FORMULA_LIMITS.string)fail('limit','Explanation expression exceeds its string limit',e.loc);return {type:'string',value:text};}
    if(['+','-','*','/'].includes(e.operator)){
     if(left.type!=='decimal'||right.type!=='decimal')fail('type','Arithmetic requires Decimal values',e.loc);const a=decimal(left.value,e.loc),b=decimal(right.value,e.loc);
     const n=e.operator==='+'?a+b:e.operator==='-'?a-b:e.operator==='*'?roundedDivision(a*b,SCALE,e.loc):roundedDivision(a*SCALE,b,e.loc);
     return {type:'decimal',value:decimalText(bounded(n,e.loc))};
    }
    if(left.type!==right.type)fail('type','Comparison values must have matching types',e.loc);
    let order:number;
    if(left.type==='decimal'&&right.type==='decimal'){const a=decimal(left.value,e.loc),b=decimal(right.value,e.loc);order=a===b?0:a<b?-1:1;}
    else if(left.type==='boolean'&&right.type==='boolean')order=left.value===right.value?0:left.value?1:-1;
    else if(typeof left.value==='string'&&typeof right.value==='string')order=left.value===right.value?0:left.value<right.value?-1:1;
    else fail('type','Comparison values must have matching types',e.loc);
    let comparison:boolean;
    switch(e.operator){case '=':comparison=order===0;break;case '<>':comparison=order!==0;break;case '<':comparison=order<0;break;case '<=':comparison=order<=0;break;case '>':comparison=order>0;break;case '>=':comparison=order>=0;break;default:fail('operator','Unsupported comparison operator',e.loc);}
    return {type:'boolean',value:comparison};
   }
   case 'call':{
    const fn=payFormulaFunction(e.code)!;const args=e.args.map(arg=>expression(arg,env));
    if(fn.code==='Rounding')return {type:'decimal',value:roundFormulaDecimal(String(args[0].value),args[1]?Number(args[1].value):2)};
    if(fn.code==='Date')return {type:'date',value:String(args[0].value)};
    const request:FormulaRequest={code:fn.code,args,loc:e.loc};let supplied:unknown;
    try{supplied=runtime.resolve(request);}catch(error){if(error instanceof PayFormulaError)throw error;fail('source',`Payroll source ${fn.code} is unavailable or not permitted`,e.loc);}
    const value=valueOf(supplied,e.loc),expected=fn.returns==='field'?fieldType(fn.code,String(args[0].value)):fn.returns;
    if(value.type!==expected)fail('source_type',`Payroll source ${fn.code} returned the wrong type`,e.loc);
    readLength+=display(value).length+args.reduce((sum,arg)=>sum+display(arg).length,0);if(reads.length>=limits.reads||readLength>limits.readLength)fail('limit','Formula source trace exceeded its limit',e.loc);
    reads.push({...request,args:args.map(arg=>({...arg})),value:{...value}});return value;
   }
  }
 };
 const block=(statements:FormulaStatement[],env:Environment):FormulaValue|undefined=>{
  for(const statement of statements){step(statement.loc);switch(statement.kind){
   case 'comment':break;
   case 'declare':env.set(statement.name.toLowerCase(),{type:statement.type,value:expression(statement.value,env)});break;
   case 'assign':{const cell=env.get(statement.name.toLowerCase());if(!cell)fail('identifier','Variable is unavailable',statement.loc);cell.value=expression(statement.value,env);break;}
   case 'explain':{const text=display(expression(statement.value,env));textLength+=text.length;if(explanations.length>=limits.explanations||textLength>limits.explanationLength)fail('limit','Formula explanation output exceeded its limit',statement.loc);explanations.push(text);break;}
   case 'return':return expression(statement.value,env);
   case 'if':{let selected=statement.otherwise;for(const branch of statement.branches){const condition=expression(branch.condition,env);if(condition.type!=='boolean')fail('type','Condition must be Boolean',statement.loc);if(condition.value){selected=branch.body;break;}}const value=block(selected,new Map(env));if(value)return value;break;}
  }}return undefined;
 };
 const result=block(program.statements,new Map());if(!result||result.type!=='decimal')fail('return','Formula did not return a Decimal amount');
 return {amount:normalizeFormulaDecimal(result.value),explanations,reads,steps,registryVersion:PAY_FORMULA_REGISTRY_VERSION,evaluatorVersion:PAY_FORMULA_EVALUATOR_VERSION};
}

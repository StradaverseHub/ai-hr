/** Deterministic plain-language explanation of a parsed Pay Formula (no model; ADR-0084). The caller
 * supplies translated words and variable labels; this module only decides structure and order. */
import type {FormulaExpression,FormulaProgram,FormulaStatement} from './pay-formula-language';
import type {PayFormulaMissingItem} from './pay-formula-model';

export type FormulaExplanationRow = { depth: number; text: string };
type FormulaExplanationTranslation = ((key: string, values?: FormulaExplanationLine['values']) => string) & { has?(key: string): boolean };

export type FormulaExplanationKey='declare'|'assign'|'if'|'elseIf'|'otherwise'|'return'|'explain'|'missingZero';
export type FormulaExplanationLine={depth:number;key:FormulaExplanationKey;values:{name?:string;expression?:string;condition?:string;items?:string}};
/** Current-run Pay Item sources that count as 0 when the employee has no row of the item in the run (owner rule,
 * 13 Nov 2026; core/pay-formula-runtime.ts fromMap). {#AnotherPayItems} is not one of them. */
export const PAY_FORMULA_ZERO_WHEN_MISSING:ReadonlySet<string>=new Set(['PayItem','PayItemNoProrate','PayItemInput','Accumulation']);
export type FormulaExplanationWords={
 and:string;or:string;not:string;true:string;false:string;
 /** Translated label for a registry variable/function code. */
 variable:(code:string)=>string;
 /** Translated label for a field/choice literal argument, when one exists. */
 argument?:(code:string,value:string)=>string|undefined;
};
const OPERATORS:Readonly<Record<string,string>>={'*':'×','/':'÷','+':'+','-':'−','=':'=','<>':'≠','<':'<','<=':'≤','>':'>','>=':'≥','&':'&'};
const PRECEDENCE:Readonly<Record<string,number>>={Or:1,And:2,'=':3,'<>':3,'<':3,'<=':3,'>':3,'>=':3,'&':4,'+':5,'-':5,'*':6,'/':6};

export function explainFormulaExpression(e:FormulaExpression,words:FormulaExplanationWords,parent=0,right=false):string{
 switch(e.kind){
  case 'literal':return e.value.type==='string'?'“'+e.value.value+'”':e.value.type==='boolean'?(e.value.value?words.true:words.false):e.value.value;
  case 'name':return e.name;
  case 'call':{
   const label=words.variable(e.code);if(!e.args.length)return label;
   const args=e.args.map(arg=>arg.kind==='literal'&&arg.value.type==='string'?(words.argument?.(e.code,arg.value.value)??arg.value.value):explainFormulaExpression(arg,words));
   return label+' ('+args.join(', ')+')';
  }
  case 'unary':return e.operator==='Not'?words.not+' '+explainFormulaExpression(e.operand,words,7):(e.operator==='-'?'−':'')+explainFormulaExpression(e.operand,words,7);
  case 'binary':{
   const p=PRECEDENCE[e.operator]??0,symbol=e.operator==='And'?words.and:e.operator==='Or'?words.or:OPERATORS[e.operator]??e.operator;
   const text=explainFormulaExpression(e.left,words,p)+' '+symbol+' '+explainFormulaExpression(e.right,words,p,true);
   // Left-associative: a right operand at the same precedence needs brackets (a − (b − c)).
   return p<parent||(right&&p===parent)?'('+text+')':text;
  }
 }
}

export function explainPayFormula(program:FormulaProgram,words:FormulaExplanationWords):FormulaExplanationLine[]{
 const lines:FormulaExplanationLine[]=[];
 const expression=(e:FormulaExpression)=>explainFormulaExpression(e,words);
 const block=(statements:FormulaStatement[],depth:number)=>{
  for(const s of statements){
   switch(s.kind){
    case 'comment':break;
    case 'declare':lines.push({depth,key:'declare',values:{name:s.name,expression:expression(s.value)}});break;
    case 'assign':lines.push({depth,key:'assign',values:{name:s.name,expression:expression(s.value)}});break;
    case 'return':lines.push({depth,key:'return',values:{expression:expression(s.value)}});break;
    case 'explain':lines.push({depth,key:'explain',values:{expression:expression(s.value)}});break;
    case 'if':
     s.branches.forEach((branch,index)=>{lines.push({depth,key:index?'elseIf':'if',values:{condition:expression(branch.condition)}});block(branch.body,depth+1);});
     if(s.otherwise.length){lines.push({depth,key:'otherwise',values:{}});block(s.otherwise,depth+1);}
     break;
   }
  }
 };
 block(program.statements,0);
 // One closing line names every current-run Pay Item read, in source order, so the rule is visible before a test.
 const items:string[]=[];
 const collect=(e:FormulaExpression)=>{switch(e.kind){
  // BASIC is always in the run (the Personnel basic), so it is never counted as 0.
  case 'call':{const first=e.args[0];const basic=e.code!=='Accumulation'&&first?.kind==='literal'&&first.value.type==='string'&&first.value.value.trim().toUpperCase()==='BASIC';
   if(PAY_FORMULA_ZERO_WHEN_MISSING.has(e.code)&&!basic){const text=expression(e);if(!items.includes(text))items.push(text);}e.args.forEach(collect);break;}
  case 'unary':collect(e.operand);break;
  case 'binary':collect(e.left);collect(e.right);break;
 }};
 const walk=(statements:FormulaStatement[])=>{for(const s of statements){switch(s.kind){
  case 'declare':case 'assign':case 'return':case 'explain':collect(s.value);break;
  case 'if':s.branches.forEach(branch=>{collect(branch.condition);walk(branch.body);});walk(s.otherwise);break;
 }}};
 walk(program.statements);
 if(items.length)lines.push({depth:0,key:'missingZero',values:{items:items.join(', ')}});
 return lines;
}
type MissingItemTranslation=(key:string,values?:Record<string,string>)=>string;
/** The localized trace line for a Pay Item a payroll result or test counted as 0. */
export function describeMissingPayItem(item:PayFormulaMissingItem,t:MissingItemTranslation):string{
 return item.source==='Accumulation'&&item.group!==undefined
  ?t('missingMemberZero',{variable:t('functions.Accumulation'),group:item.group,code:item.code})
  :t('missingItemZero',{variable:t('functions.'+item.source),code:item.code});
}

/** Localize the read-only projection without exposing the source or syntax tree. */
export function describePayFormula(program: FormulaProgram, t: FormulaExplanationTranslation): FormulaExplanationRow[] {
 const words: FormulaExplanationWords = {
  and: t('explain.and'), or: t('explain.or'), not: t('explain.not'),
  true: t('true'), false: t('false'), variable: code => t('functions.' + code),
  // A Personnel field is named by its translated label (for example companyCode → "Company code"), so the
  // explanation says which company value is compared rather than repeating the source key.
  argument: (code, value) => (code === 'EmployeeProfile' || code === 'EmployeeInformation') && t.has?.('fields.' + value) ? t('fields.' + value) : undefined,
 };
 return explainPayFormula(program, words).map(({ depth, key, values }) => ({
  depth,
  text: t('explain.' + key, values),
 }));
}

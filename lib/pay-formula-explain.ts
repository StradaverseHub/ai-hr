/** Deterministic plain-language explanation of a parsed Pay Formula (no model; ADR-0084). The caller
 * supplies translated words and variable labels; this module only decides structure and order. */
import type {FormulaExpression,FormulaProgram,FormulaStatement} from './pay-formula-language';

export type FormulaExplanationKey='declare'|'assign'|'if'|'elseIf'|'otherwise'|'return'|'explain';
export type FormulaExplanationLine={depth:number;key:FormulaExplanationKey;values:{name?:string;expression?:string;condition?:string}};
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
 return lines;
}

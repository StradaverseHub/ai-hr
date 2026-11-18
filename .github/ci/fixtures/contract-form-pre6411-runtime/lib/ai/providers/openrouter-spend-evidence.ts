/** Bounded lossless JSON for MONEY EVIDENCE only; ordinary completion parsing remains unchanged.
 * Never regex-search model text for a cost. Duplicate keys anywhere invalidate monetary evidence.
 * Compatible with Node20/22; no JSON.parse source-context extension is assumed. */
class DecimalToken { constructor(readonly text:string){} }
type Value=null|boolean|string|DecimalToken|Value[]|{[key:string]:Value};
export function parseSpendEvidenceJson(text:string):Value{
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>2*1024*1024)throw Error('Invalid evidence');let at=0,nodes=0;
 const ws=()=>{while(at<text.length&&/[\u0009\u000a\u000d\u0020]/.test(text[at]))at++;};
 const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='"')return JSON.parse(text.slice(start,at)) as string;if(c==='\\'){if(at>=text.length)throw Error('Invalid evidence');at++;}else if(c.charCodeAt(0)<32)throw Error('Invalid evidence');}throw Error('Invalid evidence');};
 const read=(depth:number):Value=>{if(depth>64||++nodes>65536)throw Error('Invalid evidence');ws();const c=text[at];
  if(c==='"')return string();
  if(c==='{'){at++;const result:{[key:string]:Value}=Object.create(null),seen=new Set<string>();ws();if(text[at]==='}'){at++;return result;}while(true){ws();if(text[at]!=='"')throw Error('Invalid evidence');const key=string();if(seen.has(key))throw Error('Invalid evidence');seen.add(key);ws();if(text[at++]!==':')throw Error('Invalid evidence');result[key]=read(depth+1);ws();const end=text[at++];if(end==='}')return result;if(end!==',')throw Error('Invalid evidence');}}
  if(c==='['){at++;const result:Value[]=[];ws();if(text[at]===']'){at++;return result;}while(true){result.push(read(depth+1));ws();const end=text[at++];if(end===']')return result;if(end!==',')throw Error('Invalid evidence');}}
  for(const[literal,value]of [['true',true],['false',false],['null',null]] as const)if(text.startsWith(literal,at)){at+=literal.length;return value;}
  const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));if(!match)throw Error('Invalid evidence');at+=match[0].length;return new DecimalToken(match[0]);
 };
 const result=read(0);ws();if(at!==text.length)throw Error('Invalid evidence');return result;
}
function object(value:Value):{[key:string]:Value}{if(!value||typeof value!=='object'||Array.isArray(value)||value instanceof DecimalToken)throw Error('Invalid evidence');return value;}
/** Exact decimal arithmetic; conservative ceil to nano-USD, never float round-down. */
export function exactUsdDecimalNanos(value:string):string{
 const match=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);if(!match||value.length>128)throw Error('Invalid USD evidence');
 const exponent=Number(match[3]??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>32)throw Error('Invalid USD evidence');
 const fraction=match[2]??'',mantissa=BigInt(match[1]+fraction),power=9+exponent-fraction.length;
 let nanos:bigint;if(power>=0)nanos=mantissa*BigInt("10")**BigInt(power);else{const denominator=BigInt("10")**BigInt(-power);nanos=(mantissa+denominator-BigInt("1"))/denominator;}
 if(nanos>BigInt("9223372036854775807"))throw Error('Invalid USD evidence');return nanos.toString();
}
function canonicalDecimal(value:string):string{
 const match=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);if(!match)throw Error('Invalid USD evidence');let coefficient=BigInt(match[1]+(match[2]??'')),power=Number(match[3]??0)-(match[2]?.length??0);if(coefficient===BigInt("0"))return '0';while(coefficient%BigInt("10")===BigInt("0")){coefficient/=BigInt("10");power++;}return coefficient.toString()+'e'+power;
}
export type OpenRouterChargeEvidence=Readonly<{generationId:string;model:string;chargeNanos:string;exactCostUsd:string}>;
export function readOpenRouterInlineCharge(text:string):OpenRouterChargeEvidence{
 const root=object(parseSpendEvidenceJson(text)),usage=object(root.usage),cost=usage.cost;
 if(typeof root.id!=='string'||!/^gen-[A-Za-z0-9_-]{1,240}$/.test(root.id)||typeof root.model!=='string'||root.model.length>200||!(cost instanceof DecimalToken))throw Error('Invalid evidence');
 return Object.freeze({generationId:root.id,model:root.model,chargeNanos:exactUsdDecimalNanos(cost.text),exactCostUsd:canonicalDecimal(cost.text)});
}
export function readOpenRouterGenerationCharge(text:string):OpenRouterChargeEvidence{
 const root=object(parseSpendEvidenceJson(text));if(root.error!==undefined)throw Error('Invalid evidence');const data=object(root.data),cost=data.total_cost;
 if(typeof data.id!=='string'||!/^gen-[A-Za-z0-9_-]{1,240}$/.test(data.id)||typeof data.model!=='string'||data.model.length>200||data.is_byok!==false||data.streamed!==false||!(cost instanceof DecimalToken))throw Error('Invalid evidence');
 return Object.freeze({generationId:data.id,model:data.model,chargeNanos:exactUsdDecimalNanos(cost.text),exactCostUsd:canonicalDecimal(cost.text)});
}

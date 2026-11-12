/** Exact PostgreSQL `numeric` arithmetic and `LIKE` matching for preloaded read models.
 *
 * A preloaded owner answers an aggregate statement it no longer sends from the rows that statement would have
 * read. The answer must be the text the driver would have returned, not a binary float: `sum(numeric)` is exact
 * and its display scale is the largest input scale, `coalesce(sum(x), 0)` over no row is the integer `0`, and a
 * negated zero prints without a sign. Every consumer then applies its own unchanged `Number(...)` and rounding. */
export type PgNumeric={readonly digits:bigint;readonly scale:number};
const NUMERIC_TEXT=/^(-)?(\d+)(?:\.(\d+))?$/;
// BigInt via the constructor: this repo targets ES2017, where bigint literals do not compile.
const ZERO=BigInt(0),TEN=BigInt(10);

export function parseNumeric(text:string):PgNumeric{
 const match=NUMERIC_TEXT.exec(text);
 if(!match)throw new Error('Unsupported numeric value in a preloaded read.');
 const fraction=match[3]??'',digits=BigInt(match[2]+fraction);
 return {digits:match[1]?-digits:digits,scale:fraction.length};
}
const rescaled=(value:PgNumeric,scale:number)=>value.digits*TEN**BigInt(scale-value.scale);
export function addNumeric(a:PgNumeric,b:PgNumeric):PgNumeric{
 const scale=Math.max(a.scale,b.scale);
 return {digits:rescaled(a,scale)+rescaled(b,scale),scale};
}
export const negateNumeric=(value:PgNumeric):PgNumeric=>({digits:-value.digits,scale:value.scale});
export const subtractNumeric=(a:PgNumeric,b:PgNumeric)=>addNumeric(a,negateNumeric(b));
export function compareNumeric(a:PgNumeric,b:PgNumeric):number{
 const scale=Math.max(a.scale,b.scale),x=rescaled(a,scale),y=rescaled(b,scale);
 return x<y?-1:x>y?1:0;
}
export const NUMERIC_ZERO:PgNumeric={digits:ZERO,scale:0};
/** PostgreSQL's numeric output: exactly `scale` fraction digits, no sign on zero, never an exponent. */
export function numericText(value:PgNumeric):string{
 const negative=value.digits<ZERO;
 let text=(negative?-value.digits:value.digits).toString();
 if(value.scale>0){text=text.padStart(value.scale+1,'0');text=text.slice(0,-value.scale)+'.'+text.slice(-value.scale);}
 return (negative?'-':'')+text;
}
/** `sum(x)`: NULL (here null) over no row, otherwise the exact total at the widest input scale. */
export function sumNumeric(values:readonly PgNumeric[]):PgNumeric|null{
 if(values.length===0)return null;
 return values.reduce(addNumeric);
}
/** `coalesce(sum(x), 0)` as the driver returns it. */
export function coalescedSumText(values:readonly PgNumeric[]):string{
 const total=sumNumeric(values);
 return total?numericText(total):'0';
}
/** `coalesce(-sum(x), 0)` as the driver returns it. */
export function coalescedNegatedSumText(values:readonly PgNumeric[]):string{
 const total=sumNumeric(values);
 return total?numericText(negateNumeric(total)):'0';
}

/** `value LIKE pattern` with PostgreSQL's default backslash escape: `%` is any run of characters, `_` exactly one
 * character, both across line breaks. A NULL value never matches (SQL unknown is not true in a WHERE). */
export function sqlLike(value:string|null|undefined,pattern:string):boolean{
 if(value==null)return false;
 let source='';
 for(let index=0;index<pattern.length;index++){
  const character=pattern[index];
  if(character==='\\'){index++;source+=escapeRegExp(pattern[index]??'');}
  else if(character==='%')source+='[\\s\\S]*';
  else if(character==='_')source+='[\\s\\S]';
  else source+=escapeRegExp(character);
 }
 return new RegExp('^'+source+'$','u').test(value);
}
const escapeRegExp=(text:string)=>text.replace(/[.*+?^${}()|[\]\\/-]/g,'\\$&');

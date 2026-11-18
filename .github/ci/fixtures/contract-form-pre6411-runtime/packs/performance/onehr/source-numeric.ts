/** Python's nearest-integer rounding, with exact halves going to the even integer. */
export function sourceRound(value:number):number{
 const floor=Math.floor(value),fraction=value-floor;
 return fraction===0.5?floor%2===0?floor:floor+1:Math.round(value);
}
/** Python round(float, ndigits): round the exact binary64 value, not a prematurely scaled float. */
export function sourceFigure(value:number|null,digits=2):number|null{
 if(value==null)return null;
 if(!Number.isFinite(value)||!Number.isInteger(digits)||digits<0||digits>6)throw Error('Invalid source figure.');
 if(value===0)return value;
 const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,Math.abs(value),false);const bits=bytes.getBigUint64(0,false);
 const exponentBits=Number((bits>>BigInt(52))&BigInt(2047)),fraction=bits&((BigInt(1)<<BigInt(52))-BigInt(1));
 const mantissa=exponentBits===0?fraction:fraction+(BigInt(1)<<BigInt(52)),exponent=(exponentBits||1)-1023-52;
 let numerator=mantissa*(BigInt(10)**BigInt(digits)),denominator=BigInt(1);
 if(exponent>=0)numerator<<=BigInt(exponent);else denominator<<=BigInt(-exponent);
 let whole=numerator/denominator;const remainder=numerator%denominator;
 if(remainder*BigInt(2)>denominator||remainder*BigInt(2)===denominator&&whole%BigInt(2)!==BigInt(0))whole++;
 const text=whole.toString().padStart(digits+1,'0'),decimal=digits?`${text.slice(0,-digits)}.${text.slice(-digits)}`:text;
 return Number(`${value<0?'-':''}${decimal}`);
}
/** The source `_commas` display retains fractional results instead of rounding them to a score. */
export function sourceGroupedFigure(value:number):string{
 if(!Number.isFinite(value))return String(value);
 if(Number.isInteger(value))return BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
 if(Math.abs(value)<.0001)return value.toExponential().replace(/e([+-])(\d)$/,(_match,sign:string,digit:string)=>`e${sign}0${digit}`);
 const [whole,fraction]=String(value).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
}

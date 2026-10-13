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
 const exponentBits=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
 const mantissa=exponentBits===0?fraction:fraction+(1n<<52n),exponent=(exponentBits||1)-1023-52;
 let numerator=mantissa*(10n**BigInt(digits)),denominator=1n;
 if(exponent>=0)numerator<<=BigInt(exponent);else denominator<<=BigInt(-exponent);
 let whole=numerator/denominator;const remainder=numerator%denominator;
 if(remainder*2n>denominator||remainder*2n===denominator&&whole%2n!==0n)whole++;
 const text=whole.toString().padStart(digits+1,'0'),decimal=digits?`${text.slice(0,-digits)}.${text.slice(-digits)}`:text;
 return Number(`${value<0?'-':''}${decimal}`);
}

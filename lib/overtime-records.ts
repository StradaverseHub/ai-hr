/** Client-safe display projection of immutable OT records; no calculation, money or live policy. */
export type ExactOvertimeMinutes={unit:'minutes';numerator:string;denominator:string};
export type FormulaOvertimeRecord={status:'ready'|'ineligible'|'refused';cashStatus:'ready'|'ineligible'|'refused';reason:'sourceUnavailable'|'recordUnavailable'|'durationRefused'|null;payableExact:ExactOvertimeMinutes|null;sourceId:string|null;calculationId:string|null;versionId:string|null};
export type OvertimeDurationRecord={status:'ready'|'ineligible'|'refused';durationStatus:'ready'|'ineligible'|'refused';payableExact:ExactOvertimeMinutes|null;sourceId:string;calculationId:string;versionId:string|null};
const record=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
export function formulaOvertimeRecord(rawTrace:unknown,stored:OvertimeDurationRecord|undefined):FormulaOvertimeRecord|null{
 const marker=record(record(rawTrace)?.overtimePattern);
 const refused=(reason:FormulaOvertimeRecord['reason']):FormulaOvertimeRecord=>({status:'refused',cashStatus:'refused',reason,payableExact:null,sourceId:stored?.sourceId??null,calculationId:stored?.calculationId??null,versionId:stored?.versionId??null});
 if(marker?.status==='refused')return refused(marker.reason==='sourceUnavailable'?'sourceUnavailable':'recordUnavailable');
 if(marker&&!stored)return refused('recordUnavailable');
 if(!stored)return null;
 if(marker&&(marker.status!=='recorded'||marker.sourceId!==stored.sourceId||marker.calculationId!==stored.calculationId))return refused('recordUnavailable');
 if(stored.durationStatus==='refused'||!validExactMinutes(stored.payableExact))return refused('durationRefused');
 return {status:stored.durationStatus,cashStatus:stored.status,reason:null,payableExact:{...stored.payableExact!},sourceId:stored.sourceId,calculationId:stored.calculationId,versionId:stored.versionId};
}
export function validExactMinutes(x:unknown):x is ExactOvertimeMinutes{const r=record(x);return !!r&&r.unit==='minutes'&&typeof r.numerator==='string'&&/^[0-9]{1,78}$/.test(r.numerator)&&typeof r.denominator==='string'&&/^[1-9][0-9]{0,77}$/.test(r.denominator);}
const gcd=(a:bigint,b:bigint):bigint=>{while(b){const r=a%b;a=b;b=r;}return a;};
export function exactOvertimeMinutesText(value:ExactOvertimeMinutes):string{
 if(!validExactMinutes(value))throw new Error('Invalid recorded overtime duration');let n=BigInt(value.numerator),d=BigInt(value.denominator);const g=gcd(n,d);n/=g;d/=g;let rest=d,twos=0,fives=0;while(rest%BigInt('2')===BigInt('0')){rest/=BigInt('2');twos++;}while(rest%BigInt('5')===BigInt('0')){rest/=BigInt('5');fives++;}if(rest!==BigInt('1'))return n+'/'+d;const digits=Math.max(twos,fives),scaled=n*BigInt('10')**BigInt(digits)/d,text=scaled.toString().padStart(digits+1,'0');return digits?text.slice(0,-digits)+'.'+text.slice(-digits).replace(/0+$/,''):text;
}
export type OvertimeRecordSummary={knownMinutes:ExactOvertimeMinutes;unknownDays:number;formulaDays:number;legacyDays:number;complete:boolean};
export function summarizeOvertimeRecords(rows:readonly {otMinutes:number|null;formulaOvertime?:FormulaOvertimeRecord|null}[]):OvertimeRecordSummary{
 let n=BigInt('0'),d=BigInt('1'),unknownDays=0,formulaDays=0,legacyDays=0;for(const row of rows){const formula=row.formulaOvertime;if(formula)formulaDays++;else legacyDays++;let value:ExactOvertimeMinutes|null=formula?formula.status==='refused'?null:formula.payableExact:row.otMinutes===null?null:Number.isSafeInteger(row.otMinutes)&&row.otMinutes>=0?{unit:'minutes',numerator:String(row.otMinutes),denominator:'1'}:null;if(!value||!validExactMinutes(value)){unknownDays++;continue;}const vn=BigInt(value.numerator),vd=BigInt(value.denominator),g=gcd(d,vd);let nextN=n*(vd/g)+vn*(d/g),nextD=d*(vd/g);const reduce=gcd(nextN,nextD);nextN/=reduce;nextD/=reduce;if(nextN.toString().length>78||nextD.toString().length>78){unknownDays++;continue;}n=nextN;d=nextD;}
 return {knownMinutes:{unit:'minutes',numerator:n.toString(),denominator:d.toString()},unknownDays,formulaDays,legacyDays,complete:unknownDays===0};
}

export function recordedMinorUnitsText(amount:string,scale:number):string{if(!/^-?[0-9]{1,78}$/.test(amount)||!Number.isInteger(scale)||scale<0||scale>6)throw new Error('Invalid recorded money');const negative=amount.startsWith('-'),digits=(negative?amount.slice(1):amount).padStart(scale+1,'0');return (negative?'-':'')+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);}

/** Exact warning-only comparison; no duration rounding, pricing or submission decision. */
export function overtimeCapAssessment(committed:Pick<OvertimeRecordSummary,'complete'|'knownMinutes'>,requestedMinutes:number|null,capMinutes:number):{known:boolean;overCap:boolean|null;projected:ExactOvertimeMinutes|null;percent:number|null}{
 if(!committed.complete||!validExactMinutes(committed.knownMinutes)||requestedMinutes!==null&&(!Number.isSafeInteger(requestedMinutes)||requestedMinutes<0)||!Number.isSafeInteger(capMinutes)||capMinutes<=0)return {known:false,overCap:null,projected:null,percent:null};
 let n=BigInt(committed.knownMinutes.numerator)+BigInt(requestedMinutes??0)*BigInt(committed.knownMinutes.denominator),d=BigInt(committed.knownMinutes.denominator);const g=gcd(n,d);n/=g;d/=g;if(n.toString().length>78)return {known:false,overCap:null,projected:null,percent:null};const cap=BigInt(capMinutes)*d,percent=n*BigInt('100')/cap;
 return {known:true,overCap:n>cap,projected:{unit:'minutes',numerator:n.toString(),denominator:d.toString()},percent:percent>BigInt('100')?100:Number(percent)};
}

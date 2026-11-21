import {readFileSync} from 'node:fs';

const bootIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\n(?![\s\S])/;
const zeroTimeOffsets=/^monotonic +0 +0\nboottime +0 +0\n(?![\s\S])/;
const uptimePattern=/^([0-9]{1,12})[.]([0-9]{2}) [0-9]{1,15}[.][0-9]{2}\n(?![\s\S])/;

export function measuredClockIdentity(bootId,offsets){
 if(typeof bootId!=='string'||!bootIdPattern.test(bootId)||typeof offsets!=='string'||!zeroTimeOffsets.test(offsets))
  throw Error('Measured lock clock identity refused');
 return bootId;
}

export function readMeasuredClockIdentity(){
 if(process.platform!=='linux')throw Error('Measured lock clock platform refused');
 return measuredClockIdentity(readFileSync('/proc/sys/kernel/random/boot_id','ascii'),
  readFileSync('/proc/self/timens_offsets','ascii'));
}

export function validMeasuredClockCs(value){
 return Number.isSafeInteger(value)&&value>=0&&value<Math.floor(Number.MAX_SAFE_INTEGER/10000);
}

export function measuredClockCs(uptime){
 const parts=typeof uptime==='string'&&uptimePattern.exec(uptime);
 const value=parts?Number(parts[1])*100+Number(parts[2]):-1;
 if(!validMeasuredClockCs(value))throw Error('Measured lock clock reading refused');
 return value;
}

export function readMeasuredClockCs(){
 return measuredClockCs(readFileSync('/proc/uptime','ascii'));
}

export function measuredNativeBracket(opened,closed,clientOpenedCs,clientClosedCs){
 const nativeOpenedCs=measuredClockCs(opened),nativeClosedCs=measuredClockCs(closed);
 if(!validMeasuredClockCs(clientOpenedCs)||!validMeasuredClockCs(clientClosedCs)
  ||clientOpenedCs>nativeOpenedCs||nativeOpenedCs>nativeClosedCs||nativeClosedCs>clientClosedCs)
  throw Error('Measured lock clock bracket refused');
 return {nativeOpenedCs,nativeClosedCs};
}

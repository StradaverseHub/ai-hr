/** Continuous native framing. Raw retention and semantic qualification stay separate. */
import {TextDecoder} from 'node:util';
import {employeeChoiceAutoExplainMessages,employeeChoiceSqlFingerprint,bindEmployeeChoiceNativePlans,type AutoExplainMessage,type PlanMarker} from './employee-choice-auto-explain-parser';
import {employeeChoiceNativeLogBounds} from './employee-choice-native-log-parts';
const header=/^.*?\[([0-9]+)\]\s+(?:LOG|NOTICE|WARNING|ERROR|FATAL|PANIC):/gm;
export type NativeLogRecord={pid:number;bytes:number;text:string};
export function* employeeChoiceNativeLogRecords(parts:Iterable<{bytes:Buffer}>):Generator<NativeLogRecord>{
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',records=0;
 function* take(final:boolean):Generator<NativeLogRecord>{
  const matches=[...pending.matchAll(new RegExp(header.source,'gm'))];
  if(matches.length>100000)throw Error('Excessive native log messages');
  const count=final?matches.length:Math.max(0,matches.length-1);
  for(let i=0;i<count;i++){
   const begin=matches[i].index!,end=matches[i+1]?.index??pending.length,text=pending.slice(begin,end),bytes=Buffer.byteLength(text);
   if(++records>100000||bytes>employeeChoiceNativeLogBounds.recordBytes)throw Error('Native log record bound exceeded');
   yield{pid:Number(matches[i][1]),bytes,text};
  }
  if(final)pending='';else if(matches.length)pending=pending.slice(matches.at(-1)!.index!);
  if(Buffer.byteLength(pending)>employeeChoiceNativeLogBounds.recordBytes)throw Error('Incomplete native record exceeds bound');
 }
 for(const part of parts){pending+=decoder.decode(part.bytes,{stream:true});yield* take(false);}
 pending+=decoder.decode();yield* take(true);
}
/** One real phase in memory at a time, with the original binder/oracles. Every
 * record is still visited: a native body outside its actual phase refuses. */
export function* employeeChoiceNativePlanPhases(parts:Iterable<{bytes:Buffer}>,pid:number,markers:readonly PlanMarker[],body:string){
 const known=new Map<string,{marker:PlanMarker;edge:'begin'|'end'}>(),completed=new Set<string>(),bodyKey=employeeChoiceSqlFingerprint(body);
 for(const marker of markers)for(const edge of ['begin','end']as const){const key=employeeChoiceSqlFingerprint(marker[edge]);if(known.has(key))throw Error('Duplicate native plan marker');known.set(key,{marker,edge});}
 let active:PlanMarker|undefined,entries:AutoExplainMessage[]=[],bytes=0;
 for(const record of employeeChoiceNativeLogRecords(parts)){
  if(active){bytes+=record.bytes;if(bytes>employeeChoiceNativeLogBounds.phaseBytes)throw Error('Native phase exceeds64MiB');}
  if(record.pid!==pid)continue;
  for(const message of employeeChoiceAutoExplainMessages(record.text,pid)){
   const key=employeeChoiceSqlFingerprint(message.query),boundary=known.get(key);
   if(boundary?.edge==='begin'){
    if(active||completed.has(boundary.marker.label))throw Error('Duplicate or nested native plan phase');
    active=boundary.marker;entries=[message];bytes=record.bytes;continue;
   }
   if(key===bodyKey&&(!active||!active.native))throw Error('Native body plan outside its admitted phase');
   if(active)entries.push(message);
   if(boundary?.edge==='end'){
    if(!active||active.label!==boundary.marker.label)throw Error('Unmatched native plan phase');
    const bound=bindEmployeeChoiceNativePlans(entries,[active],body),label=active.label;completed.add(label);active=undefined;entries=[];bytes=0;
    yield{label,entries:bound.get(label)!};
   }
  }
 }
 if(active||completed.size!==markers.length)throw Error('Incomplete actual native plan phases');
}
/** End-marker readiness does not await the NEXT record header. Its trailing
 * native context remains in raw parts and is checked by the final full framer. */
export function employeeChoiceNativeMarkerObserver(pid:number,onMarker:(query:string)=>void){
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',markerRecord=false,notified=false,bytes=0,candidate='',querySeen=false;
 return{append(value:Buffer){
  pending+=decoder.decode(value,{stream:true});
  let end:number;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end+1);pending=pending.slice(end+1);
   header.lastIndex=0;const start=header.exec(line);
   if(start){markerRecord=Number(start[1])===pid&&/duration:.*ms\s+plan:/.test(line);notified=false;bytes=0;candidate='';querySeen=false;}
   bytes+=Buffer.byteLength(line);if(bytes>employeeChoiceNativeLogBounds.recordBytes)throw Error('Live native record exceeds bound');
   // The canonical marker query is a single JSON string property. Parse that
   // property natively, never reconstruct or execute any logged statement.
   if(markerRecord&&!notified){if(!querySeen)candidate+=line;const query=/^\s*"Query Text":\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/.exec(line);
    if(query){const text:unknown=JSON.parse(query[1]);if(typeof text!=='string')throw Error('Native marker query string required');querySeen=true;if(!/^select 1 as "aihr_ecp_[a-f0-9]{24}_(?:begin|end)"$/i.test(text.trim())){markerRecord=false;candidate='';}}
    else if(querySeen)candidate+=line;
    if(querySeen&&markerRecord){let depth=0,quoted=false,escaped=false,complete=false;const begin=candidate.indexOf('{');
     for(const char of candidate.slice(begin)){if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}else if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){complete=true;break;}}
     if(complete){const messages=employeeChoiceAutoExplainMessages(candidate,pid);if(messages.length!==1)throw Error('One complete native marker required');notified=true;onMarker(messages[0].query);}
    }
   }
  }
  if(Buffer.byteLength(pending)>employeeChoiceNativeLogBounds.recordBytes)throw Error('Live native partial line exceeds bound');
 },finish(){decoder.decode();if(pending)throw Error('Native follower ended with a partial line');}};
}

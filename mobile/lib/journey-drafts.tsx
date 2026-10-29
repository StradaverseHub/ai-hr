/** User-entered drafts survive an OS picker/unlock, in memory only. API caches still unmount at the gate. */
import { createContext,useContext,useEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import { Directory,File,Paths } from 'expo-file-system';
import { authGeneration } from './auth';
import { useSession } from './session';
import type { LeaveCommand,LeavePreviewResponse } from './api';
export type LocalAttachment={uri:string;name:string;mimeType:string;size:number};
export type ClockDraft={clockProtocol?:'signed';employmentId?:string;action:'in'|'out';phase:'idle'|'preparing'|'review'|'submitting'|'uncertain'|'done';requestId?:string;geo?:{source?:import('../../lib/mobile-clock-integrity').ClockSourceSignals;lat:number;lng:number;accuracy:number;sampledAt:number;permissionAccuracy?:'precise'|'approximate'|'unavailable'};photo?:LocalAttachment;deviceToken?:string;message?:string;receiptTime?:string;attemptStartedAt?:number;attemptReceiptTime?:string;locationIssue?:import('./errors').LocationCaptureIssue;locationAssessment?:import('../../lib/mobile-api/contract').ClockLocationResponse};
export type LeaveDraft={employmentId?:string;command:LeaveCommand;document?:LocalAttachment;phase:'edit'|'previewing'|'review'|'submitting'|'uncertain'|'done';preview?:LeavePreviewResponse;message?:string};
/**
 * M11 (D10/D11) — the claim being written, in memory only, so it survives the OS camera/file picker and the unlock it
 * forces. `receipt` lives in the protected folder (protected-document.ts) and is swept with it. `requestId` is the
 * reference of the next command (renewed on every edit); `action` names the command in flight or left uncertain.
 */
export type ClaimFormValues={claimTypeId:string;claimItemId?:string;amount:string;quantityKm:string;incurredOn:string;description:string;fieldValues:Record<string,string|boolean>};
export type ClaimDraft={employmentId?:string;requestId:string;draftId?:string;existingReceipts?:number;form:ClaimFormValues;receipt?:LocalAttachment;phase:'edit'|'sending'|'uncertain'|'done';action?:'submit'|'save';message?:string;result?:{kind:'submitted'|'saved';id:string}};
export function removeLocalFile(file?:LocalAttachment){if(file)try{const local=new File(file.uri);if(local.exists)local.delete();}catch{/* The cache is also purged at the next launch. */}}
type Drafts={clock:ClockDraft|null;leave:LeaveDraft|null;claim:ClaimDraft|null};
const EMPTY:Drafts={clock:null,leave:null,claim:null};
const Ctx=createContext<{clock:ClockDraft|null;leave:LeaveDraft|null;claim:ClaimDraft|null;putClock:(value:ClockDraft|null,expectedId?:string)=>boolean;putLeave:(value:LeaveDraft|null,expectedId?:string)=>boolean;putClaim:(value:ClaimDraft|null,expectedId?:string)=>boolean}|null>(null);
export function JourneyDraftProvider({children}:{children:ReactNode}){
  const {employmentId,status}=useSession();
  const key=JSON.stringify([authGeneration(),employmentId,status==='signedOut']);
  const current=useRef(key);current.current=key;
  const active=useRef(status);active.current=status;
  const [state,setState]=useState<{key:string;drafts:Drafts}>({key,drafts:EMPTY});
  const files=useMemo(()=>new Set<LocalAttachment>(),[key,status==='signedOut']);
  const latest=useRef(state);latest.current=state;
  useEffect(()=>{const owned=files;return ()=>{owned.forEach(removeLocalFile);owned.clear();};},[files]);
  useEffect(()=>{for(const name of ['aihr-journeys','ImagePicker','ImageManipulator','DocumentPicker'])try{const directory=new Directory(Paths.cache,name);if(directory.exists)directory.delete();}catch{}},[]);
  if(state.key!==key){const empty={key,drafts:EMPTY};latest.current=empty;setState(empty);}
  function put(kind:keyof Drafts,value:ClockDraft|LeaveDraft|ClaimDraft|null,expectedId?:string){
    if(current.current!==key || !['signedIn','locked'].includes(active.current))return false;
    const prior=latest.current.key===key?latest.current.drafts[kind]:null;
    if(expectedId && (!prior || ('command' in prior ? prior.command.requestId : prior.requestId)!==expectedId))return false;
    const file=value&&('photo' in value?value.photo:'document' in value?value.document:'receipt' in value?value.receipt:undefined);
    if(file)files.add(file);
    const next={key,drafts:{...(latest.current.key===key?latest.current.drafts:EMPTY),[kind]:value}};latest.current=next;setState(next);return true;
  }
  const drafts=state.key===key?state.drafts:EMPTY;
  return <Ctx.Provider value={{...drafts,putClock:(value,id)=>put('clock',value,id),putLeave:(value,id)=>put('leave',value,id),putClaim:(value,id)=>put('claim',value,id)}}>{children}</Ctx.Provider>;
}
export function useJourneyDrafts(){const value=useContext(Ctx);if(!value)throw new Error('Journey drafts require a provider');return value;}

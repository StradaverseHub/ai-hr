import {CHECKIN_CANCELLATION_ACTION} from '@/lib/assistant-actions/checkin-cancellation-contract';
import {CheckInCancellationModuleActionBrowserPacket} from '@/lib/assistant-actions/module-action-http';
import {GOAL_APPROVAL_ACTION} from '@/lib/assistant-actions/goal-approval-contract';
import {GoalApprovalModuleActionBrowserPacket} from '@/lib/assistant-actions/module-action-http';
import {FIXED_ITEM_ARCHIVE_ACTION} from '@/lib/assistant-actions/fixed-item-archive-contract';
import {FixedItemArchiveModuleActionBrowserPacket} from '@/lib/assistant-actions/module-action-http';
import {TP3_OPENING_MAINTENANCE_ACTION} from '@/lib/assistant-actions/tp3-opening-maintenance-contract';
import {COST_ALLOCATION_MAINTENANCE_ACTION} from '@/lib/assistant-actions/cost-allocation-maintenance-contract';
import {PAYMENT_METHOD_MAINTENANCE_ACTION} from '@/lib/assistant-actions/payment-method-maintenance-contract';
import {PASSPORT_MAINTENANCE_ACTION} from '@/lib/assistant-actions/passport-maintenance-contract';
import {EMPLOYEE_CODE_MAINTENANCE_ACTION} from '@/lib/assistant-actions/employee-code-maintenance-contract';
import {DOCUMENT_METADATA_ACTION} from '@/lib/assistant-actions/document-metadata-contract';
import {FAMILY_MAINTENANCE_ACTION} from '@/lib/assistant-actions/family-maintenance-contract';
import {BANK_MAINTENANCE_ACTION} from '@/lib/assistant-actions/bank-maintenance-contract';
/** ADR-0151 wave 1b: browser side of the generic six-operation protocol (choices, list, prepare, reopen,
 * confirm, discard) for the own overtime request and the three assigned decisions. Every packet is checked
 * against the action's strict schema before it leaves the page, and every response is checked against the
 * operation, the echoed action id and the prepared subject before the page shows it. Nothing here retries. */
import {GENERIC_CHOICES_RESPONSE_BYTES,CostAllocationMaintenanceModuleActionBrowserPacket,Tp3OpeningMaintenanceModuleActionBrowserPacket,PaymentMethodMaintenanceModuleActionBrowserPacket,PassportMaintenanceModuleActionBrowserPacket,EmployeeCodeMaintenanceModuleActionBrowserPacket,DocumentMetadataModuleActionBrowserPacket,BankMaintenanceModuleActionBrowserPacket,FamilyMaintenanceModuleActionBrowserPacket,WorkforceProfileMaintenanceModuleActionBrowserPacket,EmergencyContactMaintenanceModuleActionBrowserPacket,CompensationMaintenanceModuleActionBrowserPacket,QualificationMaintenanceModuleActionBrowserPacket,OvertimeRequestModuleActionBrowserPacket,ClaimDecisionModuleActionBrowserPacket,AttendanceDecisionModuleActionBrowserPacket,ToilDecisionModuleActionBrowserPacket,LeaveAdjustmentModuleActionBrowserPacket,MovementTransferModuleActionBrowserPacket,LeaveCreditModuleActionBrowserPacket,parseGenericModuleActionBrowserResult,type GenericModuleAction,type GenericModuleActionBrowserPacket,type GenericModuleActionBrowserResult} from '@/lib/assistant-actions/module-action-http';
import {OWN_OVERTIME_REQUEST_ACTION} from '@/lib/assistant-actions/own-overtime-request-contract';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '@/lib/assistant-actions/assigned-decision-contract';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION,HR_LEAVE_CREDIT_ACTION} from '@/lib/assistant-actions/hr-prepared-contract';
import {WORKFORCE_PROFILE_MAINTENANCE_ACTION} from '@/lib/assistant-actions/workforce-profile-maintenance-contract';
import {EMERGENCY_CONTACT_MAINTENANCE_ACTION} from '@/lib/assistant-actions/emergency-contact-maintenance-contract';
import {COMPENSATION_MAINTENANCE_ACTION} from '@/lib/assistant-actions/compensation-maintenance-contract';
import {QUALIFICATION_MAINTENANCE_ACTION} from '@/lib/assistant-actions/qualification-maintenance-contract';
export type GenericPacket=GenericModuleActionBrowserPacket&{action:GenericModuleAction};
const PACKETS={[CHECKIN_CANCELLATION_ACTION]:CheckInCancellationModuleActionBrowserPacket,[GOAL_APPROVAL_ACTION]:GoalApprovalModuleActionBrowserPacket,[COST_ALLOCATION_MAINTENANCE_ACTION]:CostAllocationMaintenanceModuleActionBrowserPacket,[TP3_OPENING_MAINTENANCE_ACTION]:Tp3OpeningMaintenanceModuleActionBrowserPacket,[FIXED_ITEM_ARCHIVE_ACTION]:FixedItemArchiveModuleActionBrowserPacket,[PAYMENT_METHOD_MAINTENANCE_ACTION]:PaymentMethodMaintenanceModuleActionBrowserPacket,[PASSPORT_MAINTENANCE_ACTION]:PassportMaintenanceModuleActionBrowserPacket,[EMPLOYEE_CODE_MAINTENANCE_ACTION]:EmployeeCodeMaintenanceModuleActionBrowserPacket,[DOCUMENT_METADATA_ACTION]:DocumentMetadataModuleActionBrowserPacket,[BANK_MAINTENANCE_ACTION]:BankMaintenanceModuleActionBrowserPacket,[FAMILY_MAINTENANCE_ACTION]:FamilyMaintenanceModuleActionBrowserPacket,[WORKFORCE_PROFILE_MAINTENANCE_ACTION]:WorkforceProfileMaintenanceModuleActionBrowserPacket,[EMERGENCY_CONTACT_MAINTENANCE_ACTION]:EmergencyContactMaintenanceModuleActionBrowserPacket,[COMPENSATION_MAINTENANCE_ACTION]:CompensationMaintenanceModuleActionBrowserPacket,[QUALIFICATION_MAINTENANCE_ACTION]:QualificationMaintenanceModuleActionBrowserPacket,[OWN_OVERTIME_REQUEST_ACTION]:OvertimeRequestModuleActionBrowserPacket,[ASSIGNED_CLAIM_DECISION_ACTION]:ClaimDecisionModuleActionBrowserPacket,[ASSIGNED_ATTENDANCE_DECISION_ACTION]:AttendanceDecisionModuleActionBrowserPacket,[ASSIGNED_TOIL_DECISION_ACTION]:ToilDecisionModuleActionBrowserPacket,[HR_LEAVE_ADJUSTMENT_ACTION]:LeaveAdjustmentModuleActionBrowserPacket,[HR_MOVEMENT_TRANSFER_ACTION]:MovementTransferModuleActionBrowserPacket,[HR_LEAVE_CREDIT_ACTION]:LeaveCreditModuleActionBrowserPacket} as const;
const fail=()=>Error('Module action unavailable.');
/** Strict packet or null. The clone keeps a later state change from altering what was checked. */
export function checkGenericPacket(value:unknown):GenericPacket|null{
 const action=(value as {action?:unknown}|null)?.action;if(typeof action!=='string'||!Object.hasOwn(PACKETS,action))return null;
 const checked=PACKETS[action as keyof typeof PACKETS].safeParse(structuredClone(value));return checked.success?checked.data as GenericPacket:null;
}
export const packetActionId=(packet:GenericPacket):string|null=>packet.operation==='reopen'?packet.actionId:packet.operation==='confirm'||packet.operation==='discard'?(packet.confirmation as {actionId:string}).actionId:null;
export async function readGenericModuleActionResponse(response:Response,packet:GenericPacket):Promise<GenericModuleActionBrowserResult>{
 const reject=async():Promise<never>=>{await response.body?.cancel().catch(()=>undefined);throw fail();};
 if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)return reject();
 const limit=packet.operation==='choices'?GENERIC_CHOICES_RESPONSE_BYTES:packet.action===CHECKIN_CANCELLATION_ACTION||packet.action===GOAL_APPROVAL_ACTION||packet.action===FAMILY_MAINTENANCE_ACTION||packet.action===BANK_MAINTENANCE_ACTION||packet.action===TP3_OPENING_MAINTENANCE_ACTION||packet.action===COST_ALLOCATION_MAINTENANCE_ACTION||packet.action===PAYMENT_METHOD_MAINTENANCE_ACTION||packet.action===EMPLOYEE_CODE_MAINTENANCE_ACTION||packet.action===PASSPORT_MAINTENANCE_ACTION||packet.action===FIXED_ITEM_ARCHIVE_ACTION||packet.action===DOCUMENT_METADATA_ACTION||packet.action===QUALIFICATION_MAINTENANCE_ACTION||packet.action===COMPENSATION_MAINTENANCE_ACTION||packet.action===EMERGENCY_CONTACT_MAINTENANCE_ACTION||packet.action===WORKFORCE_PROFILE_MAINTENANCE_ACTION?131072:32768,reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,fragments=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(++fragments>1024||bytes>limit)throw fail();parts.push(part.value);}
  const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  return parseGenericModuleActionBrowserResult(packet,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
 }catch{await reader.cancel().catch(()=>undefined);throw fail();}finally{reader.releaseLock();}
}
/** One POST to the same guarded endpoint the wave 1 panels use. */
export async function sendGenericModuleAction(packet:GenericPacket,signal:AbortSignal):Promise<GenericModuleActionBrowserResult>{
 const response=await fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
 return readGenericModuleActionResponse(response,packet);
}

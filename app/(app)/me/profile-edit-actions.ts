'use server';
import {randomUUID} from 'node:crypto';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {submitOwnProfileEdit} from '@/core/profile-edit';
import {EssProfileError,type EssProfileSubmission} from '@/lib/personnel-ess-model';
import {PersonProfileCatalogError} from '@/core/org';
import {ProfileOptionValueError} from '@/core/profile-options';
import {DependentValidationError} from '@/core/dependents';
import {QualificationValidationError} from '@/core/qualifications';
import {EmergencyContactValidationError} from '@/core/emergency-contacts';
export async function saveMyProfileEditAction(input:EssProfileSubmission){
 const ctx=await getSession();
 try{
  const value=await submitOwnProfileEdit(ctx,input);revalidatePath('/me');revalidatePath('/approvals');
  return {ok:true as const,value};
 }catch(error){
  if(error instanceof EssProfileError)return {ok:false as const,code:error.code,fieldIds:error.fieldIds};
  if(error instanceof PersonProfileCatalogError||error instanceof ProfileOptionValueError||error instanceof DependentValidationError||error instanceof QualificationValidationError||error instanceof EmergencyContactValidationError)return {ok:false as const,code:'invalid' as const,fieldIds:[]};
  const reference='PROFILE-'+randomUUID().slice(0,8).toUpperCase();console.error('[profile-edit]',reference,error);
  return {ok:false as const,code:'system' as const,fieldIds:[],reference};
 }
}

export async function readMyProfileMovementAction(input:{employmentId:string;movementId:string}){
 const ctx=await getSession();
 try{const {readOwnProfileMovementComparison}=await import('@/core/profile-view');return {ok:true as const,records:await readOwnProfileMovementComparison(ctx,input)};}
 catch(error){if(error instanceof EssProfileError)return {ok:false as const,code:error.code};const reference='PROFILE-'+randomUUID().slice(0,8).toUpperCase();console.error('[profile-history]',reference,error);return {ok:false as const,code:'system' as const};}
}

'use server';
import {scopedAdmin} from '@/lib/scope';
import {publicErrorMessage} from '@/lib/public-error';
import {calculateAttendanceFormulaResult,reviewAttendanceFormulaResult,readAttendanceFormulaResult} from '@/packs/attendance/service';
import {transferAttendanceFormulaResults} from '@/packs/payroll/service';
import {revalidatePath} from 'next/cache';
async function perform<T>(run:()=>Promise<T>){try{const value=await run();revalidatePath('/attendance/individual');return {ok:true as const,value};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}}
export async function calculateAttendancePayItemAction(p:{id:string;employmentId:string;date:string}){return perform(async()=>{const {s,scopeIds}=await scopedAdmin();await calculateAttendanceFormulaResult(s,{...p,companyIds:scopeIds});return {calculated:true};});}
export async function reviewAttendancePayItemAction(p:{resultId:string;command:'review'|'approve';reason:string}){return perform(async()=>{const {s,scopeIds}=await scopedAdmin(),result=await readAttendanceFormulaResult(s,p.resultId);if(!scopeIds.includes(result.companyId))throw Error('Choose the result company in your selected scope.');return reviewAttendanceFormulaResult(s,p);});}
export async function readAttendancePayItemAction(id:string){return perform(async()=>{const {s,scopeIds}=await scopedAdmin(),result=await readAttendanceFormulaResult(s,id);if(!scopeIds.includes(result.companyId))throw Error('Choose the result company in your selected scope.');return result;});}
export async function transferAttendancePayItemsAction(p:{batchId:string;resultIds:string[];reason:string}){return perform(async()=>{const {s,scopeIds}=await scopedAdmin();if(!Array.isArray(p.resultIds)||p.resultIds.length>128)throw Error('Choose a bounded result selection.');for(const id of p.resultIds){const result=await readAttendanceFormulaResult(s,id);if(!scopeIds.includes(result.companyId))throw Error('Choose the result company in your selected scope.');}return transferAttendanceFormulaResults(s,p);});}

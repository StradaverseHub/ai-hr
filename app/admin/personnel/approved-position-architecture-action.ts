'use server';
import {getSession} from '@/lib/session';
import {approvedPositionArchitecture,ArchitectureError} from '@/packs/job-architecture/service';
export async function readApprovedPositionArchitecture(input:{companyId:string;positionId:string}){try{return {value:await approvedPositionArchitecture(await getSession(),input)};}catch(error){return {error:error instanceof ArchitectureError?error.code:'invalid'};}}

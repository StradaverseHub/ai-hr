'use server';
import {getSession} from '@/lib/session';
import {unlockPasswordAccount} from '@/core/password-policy';
export async function unlockPasswordAccountAction(_state:{status:string},form:FormData){
 try{await unlockPasswordAccount(await getSession(),String(form.get('userId')??''));return {status:'saved'};}
 catch{return {status:'failed'};}
}

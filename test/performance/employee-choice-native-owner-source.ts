/** Mechanical preservation inverse only. Never executes the frozen legacy code. */
export function employeeChoiceNativeOwnerInverse(factory:string){
 const read='async function readNativeSecurity(query:ISql){',type='export type EmployeeChoiceNativeInstallation=',binding='/** Fixed native owner only.',install='async function install(';
 const unique=(marker:string)=>{const first=factory.indexOf(marker);if(first<0||factory.indexOf(marker,first+1)!==-1)throw Error('Unique factory inverse boundary required');return first;};
 const r=unique(read),t=unique(type),b=unique(binding),i=unique(install),end=unique(' return{security:()=>readNativeSecurity(getQuery()),install};\n}');
 if(!(r<t&&t<b&&b<i&&i<end))throw Error('Factory inverse boundary order differs');
 const header=factory.slice(0,r).replace("import type {ISql,Sql} from 'postgres';\n","import {owner} from '../harness';\n");
 const security=factory.slice(r,t).replace(read,'export async function employeeChoiceNativeSecurity(){').replaceAll('await query`','await owner.client`');
 const types=factory.slice(t,b).replace('typeof readNativeSecurity','typeof employeeChoiceNativeSecurity');
 const body=factory.slice(i,end).replace(install,'export async function installEmployeeChoiceNativePrototype(')
  .replace(' // BORROWED_TRANSACTION_SECURITY: never reacquire a max1 owner pool.\n','')
  .replaceAll('readNativeSecurity(getQuery())','employeeChoiceNativeSecurity()')
  .replaceAll('readNativeSecurity(tx)','employeeChoiceNativeSecurity()').replaceAll('getQuery()','owner.client');
 return header+security+types+body;
}

/** Legacy dynamic harness binding. Pool/defaults and public API are unchanged. */
import {owner} from '../harness';
import {employeeChoiceNativePrototypeOwner,type EmployeeChoiceNativeInstallation} from './employee-choice-native-purpose-owner-factory';
export {employeeChoicePrototypeSignature,employeeChoicePrototypeSqlSha256} from './employee-choice-native-purpose-owner-factory';
export type {EmployeeChoiceNativeInstallation} from './employee-choice-native-purpose-owner-factory';
const legacy=employeeChoiceNativePrototypeOwner(()=>owner.client);
export async function employeeChoiceNativeSecurity(){return legacy.security();}
export async function installEmployeeChoiceNativePrototype(adopt?:(value:EmployeeChoiceNativeInstallation)=>void):Promise<EmployeeChoiceNativeInstallation>{return legacy.install(adopt);}

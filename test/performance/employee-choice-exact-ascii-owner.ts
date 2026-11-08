/** Legacy dynamic default binding; bounded callers use the private factory. */
import {owner} from '../harness';
import {exactAsciiEmployeeChoiceOwner,type ExactAsciiOwnership} from './employee-choice-exact-ascii-owner-factory';
import {preserveDiagnosticFailure} from './employee-choice-native-purpose-session';
const legacy=exactAsciiEmployeeChoiceOwner(()=>owner.client,()=> 'work');
export async function installExactAsciiEmployeeChoicePrototype(){
 let custody:ExactAsciiOwnership|undefined;
 try{return await legacy.install(value=>{custody=value;});}
 catch(error){await preserveDiagnosticFailure(async()=>{throw error;},async()=>{await custody?.remove();});throw error;}
}

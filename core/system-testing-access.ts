/** Administrative library purposes remain separate from actual assigned tester work. */
import type {Tx} from '../db/client';
import {settingsAccessTx,type ConfigurationOperation} from './organisation-access';
import {TestingRefusal} from '../lib/system-testing/model';
export async function requireTestingAdministrationTx(tx:Tx,operation:ConfigurationOperation='view'){
 if(!await settingsAccessTx(tx,operation,'systemTesting'))throw new TestingRefusal('not_assigned');
}

/** Explicit root-only scheduling CLI; never invoked by installation, app, broker or sender. */
import {withSchedulingLock,planReportScheduling,activateReportScheduling,rollbackReportScheduling} from './report-scheduling';
import type {InternalReportDispatchMarker} from '../../lib/employee-master-dispatch';
declare const INTERNAL_REPORT_DISPATCH_SOURCE_PINS:InternalReportDispatchMarker['sourcePins'];
async function main(){const args=process.argv.slice(2);await withSchedulingLock(async()=>{
 if(args.length===2&&args[0]==='--plan'){const plan=await planReportScheduling(args[1],INTERNAL_REPORT_DISPATCH_SOURCE_PINS);console.log('Reviewed scheduler inventory SHA256: '+plan.inventorySha256);console.log('Existing provisioning cron owner: '+plan.legacyUser);return;}
 if(args.length===3&&args[0]==='--activate'){const result=await activateReportScheduling(args[1],INTERNAL_REPORT_DISPATCH_SOURCE_PINS,args[2]);console.log('Internal report scheduling active. Installation ID: '+result.installationId);return;}
 if(args.length===2&&args[0]==='--rollback'){await rollbackReportScheduling(args[1]);console.log('Owned internal report cron removed; unchanged legacy report stage restored.');return;}
 throw new Error('Unknown scheduling command.');
 });}
main().catch(()=>{console.error('Report scheduling handoff refused; inspect owned files/private receipt. No process was killed or user crontab rewritten.');process.exitCode=1;});

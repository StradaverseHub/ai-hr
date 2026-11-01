import { runEntraWorker } from '../../lib/entra/worker';
import { internalSelected, internalReady } from '../../lib/internal-auth/config';
if(!internalSelected()||!internalReady())throw Error('Entra worker requires configured embedded authentication.');
try { console.log(JSON.stringify(await runEntraWorker())); }
catch { console.error('Entra provisioning worker failed; inspect the scoped status queue.');process.exitCode=1; }
finally { const {client}=await import('../../db/client');await client.end(); }

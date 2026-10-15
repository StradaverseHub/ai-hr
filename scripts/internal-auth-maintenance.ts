import { flushAuthMail } from '../lib/internal-auth/mail';
import { client } from '../db/client';
import { internalSelected, internalConfig } from '../lib/internal-auth/config';
if (!internalSelected()) process.exit(0);
internalConfig();
try { await flushAuthMail(); }
catch { console.error('Authentication mail maintenance unavailable.'); process.exitCode = 1; }
finally { await client.end(); }

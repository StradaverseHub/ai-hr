import { readFileSync } from 'node:fs';
import { cleanupCiBuildSession } from './staging-build-install.mjs';

const [source, installId, buildRecordId, recoveryPath] = process.argv.slice(2);
try {
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  const result = await cleanupCiBuildSession(source, installId, buildRecordId, recovery);
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n',
    error => error ? reject(error) : resolve()));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

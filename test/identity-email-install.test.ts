import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('installed identity service execution boundary',()=>{
 it('pairs the service with a root-owned private runtime copy rather than the web-owned runtime',()=>{
  const unit=readFileSync('deploy/identity-email/aihr-identity-email.service','utf8');
  const installer=readFileSync('deploy/identity-email/install.ts','utf8');
  const exec=unit.match(/^ExecStart=(\S+) (\S+)$/m);
  expect(exec).not.toBeNull();
  expect(exec!.slice(1)).toEqual(['/usr/local/lib/aihr-identity-email/node','/usr/local/lib/aihr-identity-email/agent.cjs']);
  expect(installer).toContain("copyFile(process.execPath,dest+'/node',constants.COPYFILE_EXCL)");
  expect(installer).toContain("chown(dest+'/node',0,0)");
  expect(installer).toContain('stat.uid!==0||(stat.mode&0o022)!==0');
 });
 it('drops OS privilege before scheduled maintenance executes mutable application code',()=>{
  const script=readFileSync('deploy/keycloak/maintenance.sh','utf8');
  const executableLines=script.split('\n').filter(line=>line.trim()&&!line.trim().startsWith('#'));
  const prune=executableLines.filter(line=>line.includes('scripts/keycloak-session-prune.ts'));
  expect(prune).toHaveLength(1);
  expect(prune[0]).toBe('runuser -u ubuntu -- /opt/node20/bin/node --env-file=/opt/ai-hr/.env.production --import tsx scripts/keycloak-session-prune.ts');
 });
});

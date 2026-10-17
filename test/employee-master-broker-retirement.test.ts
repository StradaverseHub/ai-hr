/** Executes only an import-safe Python helper with fake lifecycle readers; no installed runtime. */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
describe('whole broker activation retirement',()=>{
 it('refuses EOF while processes survive, foreign/deleted descriptors and invocation reuse',()=>{expect(()=>execFileSync('/usr/bin/python3',['-B','test/fixtures/managed-report-delivery/report-peer-retirement.py',path.join(process.cwd(),'deploy/identity-email/report-auth-peer.py')],{timeout:5000,stdio:'pipe'})).not.toThrow();});
 it('pins bounded ancillary receipt and retirement before exposing canonical reply to Node',()=>{const text=readFileSync('deploy/identity-email/report-auth-peer.py','utf8'),client=text.indexOf('def client_main()'),wait=text.indexOf('wait_retirement(',client),publish=text.indexOf('sys.stdout.buffer.write(reply)',client);expect(client).toBeGreaterThanOrEqual(0);expect(wait).toBeGreaterThan(client);expect(publish).toBeGreaterThan(wait);expect(publish-client).toBeGreaterThan(100);expect(text).toContain('socket.SCM_RIGHTS');expect(text).toContain('socket.MSG_CTRUNC');expect(text).toContain('os.O_NOFOLLOW');expect(text).not.toContain('peer.shutdown(socket.SHUT_WR)');});
 it('adds actual namespace process-environment denial without printing material',()=>{const text=readFileSync('deploy/identity-email/verify-internal-report-isolation.py','utf8');expect(text).toContain('def process_environment_denial(');expect(text).toContain("'/proc/'+str(target_pid)+'/environ'");expect(text).toContain("'nsenter'");expect(text).toContain("'--mount'");expect(text).toContain("'--setuid'");expect(text).toContain('assert_process_pin(');expect(text).not.toMatch(/print\([^\n]*(?:environ|AUTH_SESSION_KEY)/);});
});

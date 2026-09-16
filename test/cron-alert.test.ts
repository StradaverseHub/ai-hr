/**
 * `deploy/cron-alert.sh` and `deploy/logrotate-aihr` — readiness 1.6, the two operational pieces.
 *
 * These are files the OWNER installs; this repo cannot and must not install them. What the repo can
 * do is make sure the text it hands over actually behaves, because the failure mode being fixed is a
 * silent one and a wrapper that swallowed an exit code would reproduce it exactly, one layer up.
 *
 * So the wrapper is RUN, both arms: a job that succeeds must alert nobody, and a job that fails must
 * reach every channel AND still exit non-zero. The second is the one that matters — "an alert fired"
 * is easy to fake and "the exit status survived three alerting channels, one of which was itself
 * broken" is not.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..');
const WRAPPER = path.join(REPO, 'deploy', 'cron-alert.sh');
const LOGROTATE = path.join(REPO, 'deploy', 'logrotate-aihr');

let dir: string;
let logfile: string;
let alertSink: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihr-cron-alert-'));
  logfile = path.join(dir, 'job.log');
  alertSink = path.join(dir, 'alert.txt');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the wrapper exactly as cron would, and returns everything cron would be able to see. */
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The third channel, pointed at a file so the test can read what a human would have received.
      AIHR_ALERT_COMMAND: `cat >> ${JSON.stringify(alertSink)}`,
      ...env,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    log: fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : '',
    alert: fs.existsSync(alertSink) ? fs.readFileSync(alertSink, 'utf8') : '',
    heartbeat: (name: string) => fs.existsSync(path.join(dir, 'heartbeat', name)),
  };
}

describe('deploy/cron-alert.sh', () => {
  it('is committed executable, so rsync to the box lands a runnable file', () => {
    const mode = fs.statSync(WRAPPER).mode & 0o111;
    expect(mode, 'the owner should not have to remember chmod').not.toBe(0);
    const gitMode = execFileSync('git', ['ls-files', '-s', 'deploy/cron-alert.sh'], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
    // Only meaningful once the file is tracked; before the commit this asserts nothing, so skip then.
    if (gitMode) expect(gitMode.startsWith('100755'), `git records ${gitMode}`).toBe(true);
  });

  it('SUCCESS: exits 0, logs a dated block, touches the heartbeat, and alerts NOBODY', () => {
    const r = run(['nightly', logfile, 'sh', '-c', 'echo did the thing']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('did the thing');
    expect(r.log).toMatch(/==== \d{4}-\d{2}-\d{2}T[\d:]{8}[+-]\d{4} {2}nightly {2}exit=0/);
    expect(r.heartbeat('nightly'), 'proof of life for the staleness check').toBe(true);
    expect(r.alert, 'a healthy night must be completely silent').toBe('');
    expect(r.stdout, 'nothing on stdout means cron sends no mail').toBe('');
  });

  it('FAILURE: the exit status survives, and it reaches stdout (cron mail) and the alert command', () => {
    const r = run(['nightly', logfile, 'sh', '-c', 'echo boom >&2; exit 42']);
    expect(r.status, 'cron must still see the job as failed').toBe(42);
    expect(r.stdout, 'the channel the crontab redirect had taken away').toContain(
      'AI HR scheduled job FAILED: nightly exit=42',
    );
    expect(r.alert).toContain('AI HR scheduled job FAILED: nightly exit=42');
    expect(r.alert, 'with enough of the output to act on').toContain('boom');
    expect(r.alert).toContain(logfile);
    expect(r.log, 'stderr is still captured to the log file, as before').toContain('boom');
    expect(r.log).toContain('exit=42');
    expect(r.heartbeat('nightly'), 'a job that fails every minute must not look alive').toBe(false);
  });

  it('a BROKEN alert channel does not change the exit status or hide the failure', () => {
    const r = run(['nightly', logfile, 'sh', '-c', 'exit 3'], {
      AIHR_ALERT_COMMAND: 'this-command-does-not-exist-anywhere',
    });
    expect(r.status, 'the job failed with 3 and that is what cron must see').toBe(3);
    expect(r.stdout, 'the other two channels still fired').toContain('exit=3');
  });

  it('AIHR_ALERT_TAIL=0 withholds the job output, for an alert channel you do not control', () => {
    const r = run(['nightly', logfile, 'sh', '-c', 'echo SENSITIVE_PAYROLL_DETAIL; exit 1'], {
      AIHR_ALERT_TAIL: '0',
    });
    expect(r.status).toBe(1);
    expect(r.alert).toContain('exit=1');
    expect(r.alert, 'the tail is suppressed, the pointer to the log is not').not.toContain(
      'SENSITIVE_PAYROLL_DETAIL',
    );
    expect(r.alert).toContain(logfile);
    expect(r.log, 'and it is still in the log on the box, where it belongs').toContain(
      'SENSITIVE_PAYROLL_DETAIL',
    );
  });

  it('refuses a malformed invocation rather than silently doing nothing', () => {
    const r = run(['only-one-arg']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('usage:');
  });
});

describe('deploy/logrotate-aihr', () => {
  const text = () => fs.readFileSync(LOGROTATE, 'utf8');

  it('keeps `su ubuntu ubuntu` — without it logrotate SKIPS the directory and says nothing', () => {
    // /home/ubuntu/aihr-cron-logs is ubuntu:ubuntu and group-writable, so logrotate refuses to act on
    // it as root unless told whose privileges to drop to. Deleting this line does not break rotation
    // loudly; it stops rotation silently, which is the readiness-1.6 failure mode inside the fix for it.
    expect(text()).toMatch(/^\s*su ubuntu ubuntu\s*$/m);
  });

  it('covers the directory the crontab actually writes to', () => {
    expect(text()).toContain('/home/ubuntu/aihr-cron-logs/*.log');
  });

  it('has no dot in its name — logrotate silently ignores tabooext filenames', () => {
    expect(path.basename(LOGROTATE)).not.toContain('.');
  });

  it('bounds the history it keeps, so "rotation configured" is not "rotation forever"', () => {
    expect(text()).toMatch(/^\s*rotate \d+\s*$/m);
    expect(text()).toMatch(/^\s*(daily|weekly|monthly)\s*$/m);
  });
});

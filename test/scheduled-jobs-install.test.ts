/** deploy/scheduled-jobs/install.sh, the reviewed path that moves the minute jobs from cron and the notification user
 * timer to aihr-scheduled-jobs.service. The REAL script runs against a fake systemctl, crontab and loginctl that keep
 * their state in files, and the assertions read that state back: which crontab lines changed (only the active moved
 * jobs, commented out with a marker, never deleted), that nothing is touched when a precondition or the start fails,
 * and that rollback restores the original crontab byte for byte. */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,expect,it} from 'vitest';

const REPO=path.resolve(__dirname,'..');
const SCRIPT=path.join(REPO,'deploy','scheduled-jobs','install.sh');
const UNIT='aihr-scheduled-jobs.service',TIMER='aihr-notification-email.timer';
const MARKER='# MOVED to aihr-scheduled-jobs.service:';
const PROVISION='* * * * * cd /opt/ai-hr && /usr/bin/flock -n /tmp/aihr-provision-runner.lock deploy/cron-alert.sh provision /home/u/aihr-cron-logs/provision.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts';
const SWEEP='* * * * * cd /opt/ai-hr && flock -n -E 0 /home/u/.aihr-notification-email-sweep.lock deploy/cron-alert.sh notification-email /home/u/aihr-cron-logs/notification-email.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/notification-email-sweep.ts';
const ORIGINAL=[
 'AIHR_DB_PROCESS_ROLE=worker','AIHR_DB_POOL_MAX=2','',
 '0 3 * * * cd /opt/ai-hr && deploy/cron-alert.sh review-sweep /home/u/aihr-cron-logs/review-sweep.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/review-sweep.ts',
 PROVISION,
 '7 * * * * find /home/u/aihr-cron-logs/heartbeat -name provision -mmin +10 -exec sh -c \'echo "AI HR: provision runner has not succeeded in 10 minutes" | logger -t aihr-cron -p user.err\' \\;',
 '# STAGING PAUSED 2026-11-04: * * * * * cd /opt/ai-hr && deploy/cron-alert.sh notification-email x scripts/notification-email-sweep.ts',
 SWEEP,
 '5 * * * * cd /opt/ai-hr && /opt/aihr-report/node --import tsx scripts/provision-runner.ts --installed-internal-reports-only',
 '',
].join('\n');

let dir:string,root:string,home:string;
const FAKE_SYSTEMCTL=`#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
[ "$1" = --user ] || exit 3
shift
unit="\${@: -1}"
case "$1" in
  daemon-reload) ;;
  is-enabled) [ "$(cat "$FAKE_DIR/$unit.enabled" 2>/dev/null)" = enabled ] ;;
  is-active) [ "$(cat "$FAKE_DIR/$unit.active" 2>/dev/null)" = active ] && echo active || { echo inactive; exit 3; } ;;
  enable) echo enabled > "$FAKE_DIR/$unit.enabled"; [ "$2" = --now ] && echo active > "$FAKE_DIR/$unit.active"; true ;;
  disable) echo disabled > "$FAKE_DIR/$unit.enabled"; [ "$2" = --now ] && echo inactive > "$FAKE_DIR/$unit.active"; true ;;
  restart) [ -z "$FAKE_START_FAIL" ] || exit 1; echo active > "$FAKE_DIR/$unit.active" ;;
  *) exit 2 ;;
esac
`;
const FAKE_CRONTAB=`#!/usr/bin/env bash
echo "crontab $*" >> "$FAKE_DIR/calls"
if [ "$1" = -l ]; then [ -f "$FAKE_DIR/crontab" ] || { echo "no crontab for u" >&2; exit 1; }; cat "$FAKE_DIR/crontab"; else cp "$1" "$FAKE_DIR/crontab"; fi
`;
const FAKE_LOGINCTL=`#!/usr/bin/env bash
echo "\${FAKE_LINGER:-yes}"
`;
function fake(name:string,text:string){const file=path.join(dir,name);fs.writeFileSync(file,text,{mode:0o755});return file;}
beforeEach(()=>{
 dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aihr-scheduled-install-')));
 root=path.join(dir,'opt-ai-hr');home=path.join(dir,'home');
 fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.mkdirSync(path.join(root,'deploy','scheduled-jobs'),{recursive:true});fs.mkdirSync(home);
 fs.writeFileSync(path.join(root,'scripts','scheduled-jobs.ts'),'');fs.writeFileSync(path.join(root,'.env.production'),'');
 fs.copyFileSync(path.join(REPO,'deploy','scheduled-jobs',UNIT),path.join(root,'deploy','scheduled-jobs',UNIT));
 fs.writeFileSync(path.join(dir,'crontab'),ORIGINAL);
 fs.writeFileSync(path.join(dir,`${TIMER}.enabled`),'enabled\n');fs.writeFileSync(path.join(dir,`${TIMER}.active`),'active\n');
});
afterEach(()=>{fs.rmSync(dir,{recursive:true,force:true});});

function run(mode:string,env:Record<string,string>={}){
 const r=spawnSync('bash',[SCRIPT,mode],{cwd:root,encoding:'utf8',env:{
  PATH:process.env.PATH!,HOME:home,FAKE_DIR:dir,XDG_RUNTIME_DIR:dir,AIHR_ROOT:root,
  AIHR_SYSTEMCTL:fake('systemctl',FAKE_SYSTEMCTL),AIHR_CRONTAB:fake('crontab',FAKE_CRONTAB),AIHR_LOGINCTL:fake('loginctl',FAKE_LOGINCTL),
  AIHR_NODE20:process.execPath,...env}});
 return {status:r.status,out:r.stdout,err:r.stderr};
}
const crontab=()=>fs.readFileSync(path.join(dir,'crontab'),'utf8');
const state=(unit:string,kind:string)=>fs.existsSync(path.join(dir,`${unit}.${kind}`))?fs.readFileSync(path.join(dir,`${unit}.${kind}`),'utf8').trim():'';

it('check is read-only and names exactly the active lines install would comment out',()=>{
 const r=run('check');
 expect(r.status).toBe(0);
 expect(r.out).toContain(`  ${PROVISION}\n  ${SWEEP}\n`);
 expect(r.out).not.toContain('installed-internal-reports-only');expect(r.out).not.toContain('STAGING PAUSED');
 expect(crontab()).toBe(ORIGINAL);
 expect(fs.readFileSync(path.join(dir,'calls'),'utf8')).not.toMatch(/restart|enable|disable|crontab \//);
});

it('install starts the service first, then comments out only the moved jobs and disables the timer',()=>{
 const r=run('install');
 expect(r.err).toBe('');expect(r.status).toBe(0);
 expect(fs.readFileSync(path.join(home,'.config','systemd','user',UNIT),'utf8')).toBe(fs.readFileSync(path.join(REPO,'deploy','scheduled-jobs',UNIT),'utf8'));
 expect(state(UNIT,'enabled')).toBe('enabled');expect(state(UNIT,'active')).toBe('active');
 expect(crontab()).toBe(ORIGINAL.replace(PROVISION,`${MARKER} ${PROVISION}`).replace(SWEEP,`${MARKER} ${SWEEP}`));
 expect(state(TIMER,'enabled')).toBe('disabled');expect(state(TIMER,'active')).toBe('inactive');
 const calls=fs.readFileSync(path.join(dir,'calls'),'utf8').split('\n');
 expect(calls.findIndex(c=>c===`--user restart ${UNIT}`)).toBeLessThan(calls.findIndex(c=>c.startsWith('crontab /')));
 const backups=fs.readdirSync(path.join(home,'aihr-cron-logs')).filter(name=>name.startsWith('crontab-before-scheduled-jobs-'));
 expect(backups).toHaveLength(1);expect(fs.readFileSync(path.join(home,'aihr-cron-logs',backups[0]),'utf8')).toBe(ORIGINAL);
 // Idempotent: a second install changes no line.
 const once=crontab();expect(run('install').status).toBe(0);expect(crontab()).toBe(once);
});

it('rollback restores the original crontab byte for byte and re-enables the timer',()=>{
 expect(run('install').status).toBe(0);
 const r=run('rollback');
 expect(r.status).toBe(0);
 expect(crontab()).toBe(ORIGINAL);
 expect(state(UNIT,'enabled')).toBe('disabled');expect(state(TIMER,'enabled')).toBe('enabled');expect(state(TIMER,'active')).toBe('active');
});

it('a repeated install still lets rollback re-enable the timer the first install disabled',()=>{
 expect(run('install').status).toBe(0);expect(run('install').status).toBe(0);
 expect(run('rollback').status).toBe(0);
 expect(crontab()).toBe(ORIGINAL);expect(state(TIMER,'enabled')).toBe('enabled');
});

it('touches no schedule when the service does not start',()=>{
 const r=run('install',{FAKE_START_FAIL:'1'});
 expect(r.status).toBe(1);expect(r.err).toContain('the old schedules are untouched');
 expect(crontab()).toBe(ORIGINAL);expect(state(TIMER,'enabled')).toBe('enabled');
});

it.each([
 ['lingering is off',{FAKE_LINGER:'no'},'user lingering is off'],
 ['the release predates the service',{AIHR_ROOT:'/nonexistent'},'run from /nonexistent'],
 ['node20 is missing',{AIHR_NODE20:'/nonexistent/node'},'/nonexistent/node is missing'],
])('refuses before any change when %s',(_,env,message)=>{
 const r=run('install',env);
 expect(r.status).toBe(1);expect(r.err).toContain(message);
 expect(crontab()).toBe(ORIGINAL);expect(fs.existsSync(path.join(home,'.config','systemd','user',UNIT))).toBe(false);
});

it('the unit runs the jobs as the crontab did and deploy.sh restarts it after the web service',()=>{
 const unit=fs.readFileSync(path.join(REPO,'deploy','scheduled-jobs',UNIT),'utf8');
 expect(unit).toContain('ExecStart=/opt/node20/bin/node --env-file=.env.production --import tsx scripts/scheduled-jobs.ts --log-dir %h/aihr-cron-logs --job provision=every-minute --job notification-email=after-120s,alert-tail=0');
 expect(unit).toMatch(/^WorkingDirectory=\/opt\/ai-hr$/m);expect(unit).toMatch(/^Environment=AIHR_DB_PROCESS_ROLE=worker$/m);
 expect(unit).toMatch(/^Type=notify$/m);expect(unit).toMatch(/^KillMode=mixed$/m);expect(unit).not.toMatch(/^User=/m);
 const deploy=fs.readFileSync(path.join(REPO,'deploy','deploy.sh'),'utf8');
 const web=deploy.indexOf('sudo -n systemctl restart aihr'),jobs=deploy.indexOf('systemctl --user try-restart aihr-scheduled-jobs.service');
 expect(web).toBeGreaterThan(0);expect(jobs).toBeGreaterThan(web);
});

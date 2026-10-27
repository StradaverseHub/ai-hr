#!/usr/bin/env python3
"""Bounded staging-only installer. Runs fixed SQL via OS psql; never executes app code."""
import datetime, hashlib, json, os, pathlib, pwd, re, stat, subprocess, sys
SOURCE = 'fffabc90922c3d43b2570dc29a33ce8b70b69aca'
BUILD = 'Ym4S0kmHHYqC3vpeurUeW'
NAME = 'aihr-account-email-retention'
USER = 'aihr-maintenance'
PRIVATE = pathlib.Path('/etc/aihr/account-email-retention.env')
UNITS = pathlib.Path('/etc/systemd/system')
SERVICE = '''[Unit]
Description=AIHR account email delivery retention (fixed SQL)
After=network.target postgresql.service
[Service]
Type=oneshot
User=aihr-maintenance
EnvironmentFile=/etc/aihr/account-email-retention.env
ExecStart=/usr/bin/psql -X -qAt -v ON_ERROR_STOP=1 -c "select app.account_email_retention_prune()"
TimeoutStartSec=60
Restart=no
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
'''
TIMER = '''[Unit]
Description=Run AIHR account email delivery retention hourly
[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=300
Unit=aihr-account-email-retention.service
[Install]
WantedBy=timers.target
'''
SNAPSHOT = """select json_build_object('rows',(select count(*) from drizzle.__drizzle_migrations),'watermark',(select max(created_at)::text from drizzle.__drizzle_migrations),'days',r.days,'revision',r.revision,'lastRun',r.last_run_at,'lastDeleted',r.last_deleted,'deliveries',(select count(*) from account_email_delivery),'invitations',(select count(*) from app_invitation)) from account_email_retention r where singleton"""
class Refused(Exception): pass
def require(ok, why):
    if not ok: raise Refused(why)
def owned_regular(path, uid=0, maximum=1048576, private=False, state_metadata=False):
    path=pathlib.Path(path); before=path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==uid and before.st_size<=maximum, 'Unexpected file identity')
    require(not before.st_mode & (0o077 if private else 0o002 if state_metadata else 0o022), 'Unsafe file permissions')
    if state_metadata:require(path==pathlib.Path('/var/tmp/aihr-deploy/current') and uid==1000, 'State metadata exception is path-bound')
    data=path.read_bytes(); after=path.lstat()
    require((before.st_dev,before.st_ino,before.st_mtime_ns,before.st_size)==(after.st_dev,after.st_ino,after.st_mtime_ns,after.st_size), 'File changed during read')
    return data

def root_path(path):
    p=pathlib.Path(path); resolved=p.resolve(strict=True)
    for item in [p,*p.parents,resolved,*resolved.parents]:
        s=item.lstat()
        require(s.st_uid==0 and (stat.S_ISLNK(s.st_mode) or not s.st_mode&0o022), 'Unsafe system path')
    require(resolved.is_file() or resolved.is_dir(), 'Unexpected system path type')
    return str(p)

def database_url(text):
    values=[]
    for line in text.splitlines():
        if not re.match(r'^\s*(?:export\s+)?MIGRATION_DATABASE_URL\s*=',line): continue
        value=line.split('=',1)[1].strip()
        if value.startswith('"'):
            # Strict JSON-compatible quoted value; no shell expansion or execution.
            try:value=json.loads(value)
            except Exception:raise Refused('Unsupported private connection quoting')
        elif value.startswith("'"):
            require(value.endswith("'") and "'" not in value[1:-1], 'Unsupported private connection quoting');value=value[1:-1]
        values.append(value)
    require(len(values)==1 and isinstance(values[0],str), 'Exactly one private owner connection required')
    value=values[0]
    require(value.startswith(('postgres://','postgresql://')) and len(value)<8192 and all(ord(c)>=32 and ord(c)!=127 for c in value), 'Invalid private owner connection')
    return value

def environment_bytes(url):
    return ('PGDATABASE='+json.dumps(url,ensure_ascii=False)+'\nPGCONNECT_TIMEOUT=10\nPGOPTIONS="-c statement_timeout=30000 -c lock_timeout=5000"\n').encode()

def run(args, env=None, timeout=30):
    result=subprocess.run(args,env=env or {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'},capture_output=True,text=True,timeout=timeout)
    # Never emit raw DB errors, argv/environment or connection details.
    require(result.returncode==0, 'Fixed maintenance operation refused or failed')
    return result.stdout.strip()

def snapshot(url):
    env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PGDATABASE':url,'PGCONNECT_TIMEOUT':'10','PGOPTIONS':'-c statement_timeout=10000 -c lock_timeout=2000'}
    data=json.loads(run(['/usr/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-c',SNAPSHOT],env))
    require(data['rows']==504 and data['watermark']=='1793109999999' and data['days'] is None, 'Expected installed migration and Never delete policy required')
    return data

def unchanged(before, after):
    require(all(before[k]==after[k] for k in ['rows','watermark','days','revision','deliveries','invitations']), 'Policy or protected records changed during commissioning')
    require(after['lastRun'] is not None and after['lastDeleted']==0, 'Successful zero-deletion run required')

def exclusive(path, data, mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        os.write(fd,data);os.fchmod(fd,mode);os.fsync(fd)
    finally:os.close(fd)

def actual_source():
    require(owned_regular('/opt/ai-hr/.next/BUILD_ID',uid=1000,maximum=513).decode().strip()==BUILD, 'Reviewed email build required')
    current=owned_regular('/var/tmp/aihr-deploy/current',uid=1000,maximum=16384,state_metadata=True).decode()
    fields=dict(line.split('=',1) for line in current.splitlines() if '=' in line)
    require(fields.get('ref')==SOURCE and fields.get('result')=='ok', 'Reviewed completed staging release required')
    require(run(['/usr/bin/systemctl','is-active','aihr'])=='active', 'Staging service must be healthy')

def main(mode):
    require(mode in ('install','verify') and os.geteuid()==0 and sys.platform=='linux', 'Run this bounded helper with sudo on staging')
    for p in ['/usr/bin/psql','/usr/bin/systemctl','/usr/sbin/useradd','/usr/sbin/nologin']:root_path(p)
    actual_source()
    raw=owned_regular('/opt/ai-hr/.env.production',uid=1000,private=True)
    url=database_url(raw.decode());before=snapshot(url)
    service=UNITS/(NAME+'.service');timer=UNITS/(NAME+'.timer')
    if mode=='install':
        require(not any(p.exists() or p.is_symlink() for p in [PRIVATE,service,timer]), 'Existing maintenance files require explicit forward recovery')
        # Existing dedicated identity must not be silently repurposed.
        try:pwd.getpwnam(USER)
        except KeyError:pass
        else:raise Refused('Maintenance identity already exists; explicit verification required')
        root_path('/etc/systemd/system')
        if PRIVATE.parent.exists():root_path(PRIVATE.parent)
        else:PRIVATE.parent.mkdir(mode=0o700)
        run(['/usr/sbin/useradd','--system','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',USER])
        exclusive(PRIVATE,environment_bytes(url));exclusive(service,SERVICE.encode(),0o644);exclusive(timer,TIMER.encode(),0o644)
        run(['/usr/bin/systemctl','daemon-reload'])
    else:
        require(owned_regular(PRIVATE,private=True)==environment_bytes(url), 'Private job connection changed')
        require(owned_regular(service)==SERVICE.encode() and owned_regular(timer)==TIMER.encode(), 'Installed fixed SQL units changed')
    identity=pwd.getpwnam(USER)
    require(identity.pw_uid!=0 and identity.pw_shell=='/usr/sbin/nologin' and identity.pw_dir=='/nonexistent', 'Dedicated non-login identity required')
    # No finite policy is selected, and only fixed SQL under the dedicated identity is run.
    require(snapshot(url)==before, 'Database state changed before commissioning')
    if mode=='install':
        run(['/usr/bin/systemctl','start',NAME+'.service'],timeout=70)
    props=dict(line.split('=',1) for line in run(['/usr/bin/systemctl','show',NAME+'.service','--property=Result,ExecMainStatus,User,ExecMainStartTimestamp']).splitlines() if '=' in line)
    require(props.get('Result')=='success' and props.get('ExecMainStatus')=='0' and props.get('User')==USER and props.get('ExecMainStartTimestamp'), 'Actual successful dedicated service execution required')
    after=snapshot(url);unchanged(before,after);actual_source()
    if mode=='install':run(['/usr/bin/systemctl','enable','--now',NAME+'.timer'])
    require(run(['/usr/bin/systemctl','is-active',NAME+'.timer'])=='active', 'Timer is not active')
    require(run(['/usr/bin/systemctl','is-enabled',NAME+'.timer'])=='enabled', 'Timer is not enabled')
    timer_props=run(['/usr/bin/systemctl','show',NAME+'.timer','--property=NextElapseUSecRealtime,ActiveState,Triggers'])
    timer_fields=dict(line.split('=',1) for line in timer_props.splitlines() if '=' in line)
    require(bool(timer_fields.get('NextElapseUSecRealtime')) and timer_fields.get('Triggers')==NAME+'.service' and timer_fields.get('ActiveState')=='active', 'Actual next timer invocation required')
    print(json.dumps({'kind':'STAGING_EMAIL_RETENTION_COMMISSIONED','source':SOURCE,'buildId':BUILD,'fixedRootOwnedSqlUnit':True,'webWritableCodeExecuted':False,'retention':'Never delete','removed':0,'protectedRecordCountsPreserved':True,'serviceResult':'success','timerEnabled':True,'timerMetadata':timer_props,'observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionChanged':False}))

if __name__=='__main__':
    try:
        require(len(sys.argv)==2,'Expected install or verify mode');main(sys.argv[1])
    except Exception as error:
        print(json.dumps({'maintenanceRefused':True,'reason':str(error) if isinstance(error,Refused) else 'Bounded maintenance check failed; preserve files for forward recovery','automaticRollback':False,'credentialsDisclosed':False}));sys.exit(1)

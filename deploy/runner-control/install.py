"""Root operator commissioning, separate from application deployment. Does not activate any HR job."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import subprocess

spec=importlib.util.spec_from_file_location('broker',Path(__file__).with_name('broker.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

def validate_managed(row,web_uid):
    unit=row['unit']+'.service'
    keys=['User','FragmentPath','WorkingDirectory','DropInPaths','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','SendSIGKILL','TimeoutStopUSec','EnvironmentFiles','ExecStart']
    props=dict(line.split('=',1) for line in b.command('show',unit,*['--property='+key for key in keys]).splitlines() if '=' in line)
    b.require(props.get('User') not in ('','root') and pwd.getpwnam(props['User']).pw_uid!=web_uid,'runner needs a dedicated nonroot account')
    b.protected(props['FragmentPath'])
    import re
    binary=re.search(r'path=([^ ;]+)',props.get('ExecStart',''))
    b.require(binary is not None,'fixed executable required')
    b.protected(binary.group(1))
    for env_file in re.findall(r'([^ ]+) \(ignore_errors=(?:yes|no)\)',props.get('EnvironmentFiles','')): b.protected(env_file)
    for item in props.get('DropInPaths','').split(): b.protected(item)
    b.require(not any(props.get(key) for key in ['ExecStartPre','ExecStartPost','ExecStop','ExecStopPost']),'review unsupported unit hooks separately')
    root=b.protected(props['WorkingDirectory'])
    # No worker source/dependency may be writable by the web identity or a worker account.
    # Canonical internal dependency symlinks are allowed only inside the same immutable release.
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            path=Path(parent)/name
            if path.is_symlink():
                b.require(path.resolve().is_relative_to(root),'worker dependency escapes immutable release')
                b.protected(path.resolve())
            else: b.protected(path)
    b.require(row['frequency']!='continuous' or props.get('SendSIGKILL')=='no' and props.get('TimeoutStopUSec')=='infinity','continuous worker requires graceful, unlimited drain')
    if row['frequency']!='continuous':
        timer=b.properties(row['unit']+'.timer');b.require(timer.get('LoadState')=='loaded','timer missing')
    # Cron adoption is intentionally explicit: duplicated legacy schedules are not silently removed.
    script_names={'provision':'provision-runner.ts','accrual':'accrue-earned.ts','carry-expiry':'expire-carry.ts','reviews':'review-sweep.ts','notifications':'notification-email-sweep.ts','anomalies':'anomaly-sweep.ts','child-relief':'resync-child-relief-grid.ts','usage':'capture-usage.ts','entitlement-alarm':'entitlement-alarm.ts','ai-alerts':'ai-alerts.ts'}
    needle=script_names.get(row['id'])
    if needle:
        for user in pwd.getpwall():
            result=subprocess.run(['/usr/bin/crontab','-u',user.pw_name,'-l'],capture_output=True,text=True)
            b.require(not any(needle in line for line in result.stdout.splitlines() if not line.lstrip().startswith('#')),'legacy cron still owns this runner; migrate it in the staging window first')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--policy',required=True);parser.add_argument('--web-user',required=True);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    b.require(os.geteuid()==0,'root commissioning required')
    policy=json.loads(b.protected(Path(args.policy)).read_text());catalog=json.loads(Path(__file__).with_name('catalog.json').read_text())
    user=pwd.getpwnam(args.web_user);b.require(policy.get('webUid')==user.pw_uid and user.pw_uid>0,'web identity mismatch')
    b.require(policy.get('environment') in ('staging','production') and set(policy)=={'environment','webUid','jobs'},'invalid policy')
    b.require(set(policy['jobs'])<=set(row['id'] for row in catalog),'unknown runner')
    for row in catalog:
        value=policy['jobs'].get(row['id'],{'managed':False,'note':''})
        b.require(set(value)=={'managed','note'} and type(value['managed']) is bool and isinstance(value['note'],str) and len(value['note'])<=300,'invalid runner policy')
        b.require(not b.held(policy,row['id']) or not value['managed'],'production hold cannot be commissioned')
        if value['managed']: validate_managed(row,user.pw_uid)
    if not args.check:
        # Root must run this installer from a separately reviewed, exact accepted source package.
        target=Path('/usr/local/lib/aihr-runner-control');target.mkdir(mode=0o755,exist_ok=True);b.protected(target)
        for name in ['broker.py','catalog.json']:
            destination=target/name
            b.require(not destination.is_symlink(),'symlink target refused')
            shutil.copyfile(Path(__file__).with_name(name),destination);os.chmod(destination,0o644);os.chown(destination,0,0)
        b.ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);b.protected(b.ROOT)
        b.atomic(b.ROOT/'policy.json',json.dumps(policy))
        for suffix in ['socket','service']:
            name='aihr-runner-control.'+suffix;destination=Path('/etc/systemd/system')/name
            b.require(not destination.is_symlink(),'symlink unit refused')
            shutil.copyfile(Path(__file__).with_name(name),destination);os.chmod(destination,0o644);os.chown(destination,0,0)
        try: grp.getgrnam('aihr-runner-control')
        except KeyError: subprocess.run(['/usr/sbin/groupadd','--system','aihr-runner-control'],check=True)
        subprocess.run(['/usr/sbin/usermod','-a','-G','aihr-runner-control',args.web_user],check=True)
        b.command('daemon-reload');b.command('enable','--now','aihr-runner-control.socket')
        print('Controller socket installed. Restart the web service in its release window to acquire socket-group access. No HR runner was enabled.')
    else: print('Commissioning policy and managed runner protections verified; no changes made.')

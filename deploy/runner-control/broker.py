"""Installation-owned scheduler port. No shell, executable path, SQL or unit text from requests.

The web process may request only catalogued changes after authenticating an operator. The local socket
checks its exact UID independently. Root-owned commissioning policy decides which jobs are managed;
legacy cron entries remain external until deliberately migrated. Production holds are immutable here.
"""
import datetime
import fcntl
import hashlib
import http.server
import json
import os
import re
from pathlib import Path
import socket
import socketserver
import stat
import struct
import subprocess
import tempfile
import time
import uuid

ROOT=Path('/etc/aihr/runner-control')
STATE=Path('/var/lib/aihr-runner-control')
CATALOG=Path(__file__).with_name('catalog.json')
SYSTEMCTL='/usr/bin/systemctl'

class Refused(ValueError): pass

def require(ok,message):
    if not ok: raise Refused(message)

def protected(path):
    path=Path(path)
    require(path.is_absolute(),'absolute protected path required')
    for item in [path,*path.parents]:
        info=item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'unprotected installation configuration')
    return path

def read_policy():
    value=json.loads(protected(ROOT/'policy.json').read_text())
    require(set(value)=={'environment','webUid','jobs'},'invalid installation policy')
    require(value['environment'] in ('staging','production') and type(value['webUid']) is int and value['webUid']>0,'invalid installation identity')
    catalog=json.loads(protected(CATALOG).read_text())
    require(set(value['jobs'])<=set(row['id'] for row in catalog),'unknown commissioned runner')
    for job in value['jobs'].values():
        require(set(job)=={'managed','note'} and type(job['managed']) is bool and isinstance(job['note'],str) and len(job['note'])<=300,'invalid runner policy')
    return value,catalog

def command(*args,allow_missing=False):
    result=subprocess.run([SYSTEMCTL,*args],capture_output=True,text=True,timeout=15,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
    require(result.returncode==0 or allow_missing and 'LoadState=not-found' in result.stdout,'scheduler request failed')
    return result.stdout

def properties(unit):
    keys=['LoadState','ActiveState','UnitFileState','Result','ExecMainStatus','ExecMainExitTimestamp','NextElapseUSecRealtime','LastTriggerUSec','TimersCalendar','TimersMonotonic','ExecMainExitTimestampMonotonic','NextElapseUSecMonotonic']
    output=command('show',unit,'--no-pager',*['--property='+key for key in keys],allow_missing=True)
    result={}
    for line in output.splitlines():
        if '=' not in line:continue
        key,value=line.split('=',1)
        result[key]=(result[key]+' '+value) if key in ('TimersCalendar','TimersMonotonic') and key in result else value
    return result

def held(policy,key):
    return policy['environment']=='production' and key in ('replacement-holidays','backups')

def displayed_schedule(timer):
    calendar=re.search(r'OnCalendar=(.*?)\s*;',timer.get('TimersCalendar',''))
    if calendar:return calendar.group(1)
    interval=re.search(r'OnUnitInactiveUSec=(.*?)\s*;',timer.get('TimersMonotonic',''))
    if interval:return interval.group(1)+' after completion'
    return None

def monotonic_seconds(value):
    # systemctl renders inactive deadlines as infinity and some finite USec fields as durations.
    value=str(value or '').strip()
    if value in ('','0','n/a','infinity','[not set]'):return 0
    if value.isdigit():return int(value)/1000000
    pattern=r'([0-9]+(?:\.[0-9]+)?)(us|µs|ms|s|min|h|d|w)'
    if re.sub(pattern,'',value).strip():return 0
    units={'us':0.000001,'µs':0.000001,'ms':0.001,'s':1,'min':60,'h':3600,'d':86400,'w':604800}
    return sum(float(number)*units[unit] for number,unit in re.findall(pattern,value))

def next_run(timer):
    real=timer.get('NextElapseUSecRealtime')
    if real and real not in ('n/a','0','infinity','[not set]'):return real
    monotonic=monotonic_seconds(timer.get('NextElapseUSecMonotonic'))
    if monotonic:
        return (datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=monotonic-time.monotonic())).isoformat()
    return None

def row_status(policy,row):
    setting=policy['jobs'].get(row['id'],{'managed':False,'note':'Not commissioned; existing external schedules must be checked.'})
    service=properties(row['unit']+'.service')
    timer=properties(row['unit']+'.timer') if row['frequency']!='continuous' else {}
    active=timer or service
    installed=service.get('LoadState')=='loaded' and (row['frequency']=='continuous' or timer.get('LoadState')=='loaded')
    enabled=active.get('UnitFileState') in ('enabled','enabled-runtime')
    # A disabled schedule can still have an in-flight service; these are separate facts.
    health=('missing' if not installed else 'running' if service.get('ActiveState')=='activating' or row['frequency']=='continuous' and service.get('ActiveState')=='active' else 'failed' if service.get('Result') not in (None,'','success') else 'unknown' if not service.get('ExecMainExitTimestamp') else 'success')
    last_mono=monotonic_seconds(service.get('ExecMainExitTimestampMonotonic'))
    threshold={'daily':48*3600,'monthly':65*86400,'yearly':400*86400,'interval':48*3600,'continuous':48*3600}[row['frequency']]
    if enabled and active.get('ActiveState') not in ('active','activating'): health='stopped'
    if enabled and health=='success' and last_mono and time.monotonic()-last_mono>threshold: health='stale'
    result={'id':row['id'],'managed':setting['managed'],'hold':held(policy,row['id']),'note':setting['note'],'installed':installed,'enabled':enabled,'health':health,'running':service.get('ActiveState') in ('active','activating'),'lastRun':service.get('ExecMainExitTimestamp') or None,'nextRun':next_run(timer),'schedule':displayed_schedule(timer)}
    # Configuration-only revision: execution timestamps advance independently of operator edits.
    configuration={key:result[key] for key in ('id','managed','hold','installed','enabled','schedule')}
    configuration['environment']=policy['environment']
    configuration['timerSettings']=sorted(part.strip() for key in ('TimersCalendar','TimersMonotonic') for part in re.findall(r'On(?:\w*USec|Calendar)=[^;}]+',timer.get(key,'')))
    result['revision']=hashlib.sha256(json.dumps(configuration,sort_keys=True).encode()).hexdigest()
    return result

def schedule(row,value):
    require(isinstance(value,dict),'invalid schedule')
    if row['frequency']=='interval':
        require(set(value)=={'minutes'} and type(value['minutes']) is int and 1<=value['minutes']<=1440,'interval must be 1–1440 minutes')
        return '[Timer]\nOnCalendar=\nOnBootSec=\nOnUnitActiveSec=\nOnUnitInactiveSec=\nOnBootSec=2min\nOnUnitInactiveSec='+str(value['minutes'])+'min\nPersistent=false\n'
    require(row['frequency'] in ('daily','monthly','yearly') and set(value)=={'time'} and isinstance(value['time'],str),'invalid schedule')
    import re
    require(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',value['time']) is not None,'invalid Malaysia time')
    date={'daily':'*-*-*','monthly':'*-*-01','yearly':'*-04-01'}[row['frequency']]
    return '[Timer]\nOnCalendar=\nOnBootSec=\nOnUnitActiveSec=\nOnUnitInactiveSec=\nOnCalendar='+date+' '+value['time']+':00 Asia/Kuala_Lumpur\nPersistent=false\n'

def atomic(path,data):
    fd,name=tempfile.mkstemp(dir=path.parent,prefix='.runner-')
    try:
        with os.fdopen(fd,'w') as stream:
            os.fchmod(stream.fileno(),0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name): os.unlink(name)

def audit(value):
    with (STATE/'audit.jsonl').open('a') as stream:
        os.chmod(STATE/'audit.jsonl',0o600)
        stream.write(json.dumps(value,sort_keys=True)+'\n');stream.flush();os.fsync(stream.fileno())

def separate_capability(row):
    if row['id'] not in ('provision','reports'):return
    props=command('show',row['unit']+'.service','--property=ExecStart','--no-pager')
    if row['id']=='provision':
        require(re.search(r'(?:/|\s)scripts/provision-only-runner\.ts(?:\s|;|$)',props) is not None,'provisioning must use the independent capability')
    else:
        require('--installed-internal-reports-only' in props,'reports must use the independent capability')

def handle(body,policy,catalog):
    require(isinstance(body,dict),'invalid request')
    if body=={'op':'status'}:
        return {'environment':policy['environment'],'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runners':[row_status(policy,row) for row in catalog]}
    require(set(body)=={'op','id','actor','revision','enabled','schedule'} and body['op']=='configure','invalid request fields')
    require(isinstance(body['actor'],str) and str(uuid.UUID(body['actor']))==body['actor'],'operator identity required')
    require(type(body['enabled']) is bool and isinstance(body['revision'],str),'invalid change')
    row=next((row for row in catalog if row['id']==body['id']),None)
    require(row is not None,'unknown runner')
    current=row_status(policy,row)
    require(not current['hold'],'production hold; separate owner decision required')
    require(current['managed'] and current['installed'],'runner not commissioned for control')
    require(current['revision']==body['revision'],'runner changed; refresh before saving')
    require(body['schedule'] is None or not current['running'],'wait for the current run before rescheduling')
    if body['enabled']:separate_capability(row)
    text=schedule(row,body['schedule']) if body['schedule'] is not None else None
    unit=row['unit']+('.service' if row['frequency']=='continuous' else '.timer')
    # Intent is durable BEFORE a mutation; completion or failure is recorded afterward.
    event={'request':str(uuid.uuid4()),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'actor':body['actor'],'id':row['id'],'enabled':body['enabled'],'schedule':body['schedule'],'before':current,'outcome':'requested'}
    audit(event)
    try:
        if text is not None:
            directory=Path('/etc/systemd/system')/(unit+'.d')
            if not directory.exists(): directory.mkdir(mode=0o755)
            protected(directory)
            atomic(directory/'60-runner-control.conf',text)
            command('daemon-reload')
        if body['enabled']:
            command('enable',unit)
            if text is not None and row['frequency']!='continuous': command('restart',unit)
            else: command('start',unit)
        else:
            # Disabling a timer never interrupts the HR transaction already in flight.
            command('disable',unit)
            if row['frequency']!='continuous': command('stop',unit)
            # Commissioned continuous workers require SendSIGKILL=no and TimeoutStopSec=infinity.
            else: command('stop','--no-block',unit)
        event['outcome']='applied';event['after']=row_status(policy,row);audit(event)
        return event['after']
    except Exception:
        event['outcome']='failed';audit(event)
        raise Refused('scheduler change failed; refresh actual state before retrying')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            policy,catalog=read_policy()
            uid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
            require(uid==policy['webUid'],'caller refused')
            require(self.path=='/v1/runners' and self.headers.get('Transfer-Encoding') is None,'invalid endpoint')
            length=int(self.headers.get('Content-Length','0'));require(0<length<=4096,'invalid request size')
            self.connection.settimeout(10)
            body=json.loads(self.rfile.read(length))
            with (STATE/'operation.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                result=handle(body,policy,catalog)
            code=200
        except (ValueError,KeyError,TypeError): code=409;result={'error':'Runner request refused. Refresh the page and check installation policy.'}
        except Exception: code=503;result={'error':'Runner controller unavailable. Contact the installation operator.'}
        raw=json.dumps(result).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def log_message(self,*args): pass

if __name__=='__main__':
    require(os.geteuid()==0,'root-owned scheduler port required')
    # systemd owns and passes the listening Unix socket; no path unlink/rebinding races.
    server=socketserver.UnixStreamServer('/run/aihr-runner-control.sock',Handler,bind_and_activate=False)
    server.socket=socket.socket(fileno=3)
    server.serve_forever()

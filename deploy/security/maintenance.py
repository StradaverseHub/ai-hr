#!/usr/bin/env python3
"""Root-only, source/lease/hash-bound maintenance. Never reads SMTP credentials into a receipt.
Build embeds only the reviewed agent bytes. Private Nginx proposals are separately SHA-pinned.
"""
import argparse, base64, contextlib, fcntl, hashlib, hmac, http.client, json, os
from pathlib import Path
import re, socket, sqlite3, stat, subprocess, sys, tempfile, time, uuid, shutil
from urllib.parse import urlsplit

SOURCE_SHA = ''
AGENT_SHA256 = ''
AGENT_BASE64 = ''
NODE_SHA256 = ''
QUEUE = Path('/var/tmp/aihr-deploy/staging-release-queue')
RUNTIME = Path('/usr/local/lib/aihr-identity-email')
NODE_SOURCE = Path('/opt/node22/bin/node')
DROPIN = Path('/etc/systemd/system/aihr-identity-email.service.d/10-security-runtime.conf')
ALLOWED_NGINX = frozenset(['/etc/nginx/conf.d/00-aihr-request-protection.conf', '/etc/nginx/conf.d/aihr-sfm.conf', '/etc/nginx/conf.d/zz-aihr-onehr-staging.conf', '/etc/nginx/sites-available/aihr-identity'])

def require(ok, message):
    if not ok: raise ValueError(message)

def digest(value): return hashlib.sha256(value).hexdigest()

def regular(path, maximum=33554432, owner=0, private=False):
    path=Path(path)
    require(path.is_absolute() and path.resolve()==path, 'Canonical input required')
    fd=os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid==owner and s.st_nlink==1 and 0<s.st_size<=maximum and s.st_mode&0o022==0, 'Trusted bounded file required')
        if private: require(stat.S_IMODE(s.st_mode)==0o600, 'Private file mode required')
        chunks=[];count=0
        while count<s.st_size:
            chunk=os.read(fd,min(1048576,s.st_size-count))
            if not chunk: break
            chunks.append(chunk);count+=len(chunk)
        value=b''.join(chunks)
        require(len(value)==s.st_size and os.fstat(fd).st_mtime_ns==s.st_mtime_ns, 'Input changed during read')
        return value
    finally: os.close(fd)

def trusted_directory(path):
    p=Path(path)
    while True:
        s=p.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0, 'Root-owned directory chain required')
        if p==p.parent: break
        p=p.parent

@contextlib.contextmanager
def operation_guard(path=RUNTIME/'.security-maintenance.lock', *, owner=0):
    # Independent exclusive custody: the queue's shared lock only fences handback.
    path=Path(path)
    if owner==0: trusted_directory(path.parent)
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        s=os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid==owner and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600,'Maintenance lock custody differs')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield
    finally: os.close(fd)


def atomic(path, value, mode):
    path=Path(path);trusted_directory(path.parent)
    fd,name=tempfile.mkstemp(prefix='.aihr-security-',dir=path.parent)
    try:
        os.fchmod(fd,mode);os.fchown(fd,0,0)
        with os.fdopen(fd,'wb') as f: f.write(value);f.flush();os.fsync(f.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def command(*args):
    # No shell, app-owned interpreter/script, PATH lookup or inherited configuration.
    return subprocess.run(args,check=True,capture_output=True,timeout=120,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}).stdout.decode().strip()

class UnixHttp(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(15);self.sock.connect('/run/aihr-identity-email.sock')

def capabilities():
    c=UnixHttp('localhost',timeout=15)
    try:
        c.request('POST','/v1/notifications',body='{"op":"status"}',headers={'content-type':'application/json'})
        r=c.getresponse();body=r.read(4097);require(r.status==200 and len(body)<=4096,'Private service status unavailable')
        value=json.loads(body);require(type(value)==dict and type(value.get('version'))==int and value.get('version')==1 and type(value.get('ready'))==bool,'Unknown capability protocol')
        require(all(type(v)==bool for k,v in value.items() if k!='version'),'Unknown capability values')
        return value
    finally: c.close()


def capabilities_preserved(before,after):
    require(all(after.get(k)==v for k,v in before.items()), 'Existing mail capability/readiness changed')
    require(all(v is False for k,v in after.items() if k not in before), 'New mail capability would be enabled')


def validate_plan(plan, source=SOURCE_SHA, agent_hash=AGENT_SHA256, node_hash=NODE_SHA256):
    require(type(plan)==dict and set(plan)=={'kind','format','source','buildId','workerBefore','agentSha256','nodeSha256','files','publicOrigin'},'Exact maintenance plan fields required')
    require(plan['kind']=='STAGING_INGRESS_EMAIL_SECURITY' and type(plan['format'])==int and plan['format']==1 and plan['source']==source and re.fullmatch('[a-f0-9]{40}',source or ''),'Exact reviewed source required')
    require(re.fullmatch('[A-Za-z0-9_-]{1,160}',plan['buildId']) and re.fullmatch('[a-f0-9]{64}',plan['workerBefore']),'Exact baseline identities required')
    require(plan['agentSha256']==agent_hash and plan['nodeSha256']==node_hash and re.fullmatch('[a-f0-9]{64}',agent_hash or '') and re.fullmatch('[a-f0-9]{64}',node_hash or ''),'Artifact/runtime digest differs')
    require(type(plan['files'])==list and len(plan['files'])==4 and all(type(f)==dict for f in plan['files']) and {f.get('path') for f in plan['files']}==ALLOWED_NGINX,'Only the four reviewed Nginx targets are allowed')
    for f in plan['files']:
        require(set(f)=={'path','before','after','base64'},'Exact file proposal required')
        require(f['before'] is None or re.fullmatch('[a-f0-9]{64}',f['before']),'Baseline digest required')
        require((f['before'] is None)==(f['path']=='/etc/nginx/conf.d/00-aihr-request-protection.conf'),'Only the new managed HTTP policy may be absent')
        value=base64.b64decode(f['base64'],validate=True)
        require(0<len(value)<=1048576 and digest(value)==f['after'] and b'\x00' not in value,'Bounded exact proposal bytes required')
    origin=urlsplit(plan['publicOrigin']);require(origin.scheme=='https' and origin.hostname and origin.netloc==origin.hostname and origin.path in ('','/') and not origin.query and not origin.fragment, 'Canonical public HTTPS origin required')
    names=[]
    for f in plan['files']:
        names+=re.findall(r'^\s*server_name\s+([^;]+);',base64.b64decode(f['base64']).decode(),re.M)
    require(any(origin.hostname in n.split() for n in names),'Public origin is not a reviewed proxy host')
    return plan

@contextlib.contextmanager
def lease_guard(credential,plan,*,queue=None,app_root=None,build_file=None):
    require(type(credential)==dict and credential.get('protocol')=='aihr-staging-queue/v1' and credential.get('releaseAuthorized') is False and type(credential.get('epoch'))==int and re.fullmatch('[a-f0-9]{64}',credential.get('token','')) and re.fullmatch('[a-f0-9-]{36}',credential.get('batch','')), 'Exact private lease credential required')
    # The CLI uses only these fixed defaults; explicit paths exist for isolated real-SQLite fixtures.
    queue=QUEUE if queue is None else Path(queue);app_root=Path('/opt/ai-hr') if app_root is None else Path(app_root);build_file=Path('/opt/ai-hr/.next/BUILD_ID') if build_file is None else Path(build_file)
    owner=app_root.stat().st_uid
    q=queue.lstat();require(stat.S_ISDIR(q.st_mode) and q.st_uid==owner and stat.S_IMODE(q.st_mode)==0o700,'Queue custody differs')
    lock=queue/'operations.lock';fd=os.open(lock,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==owner and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'Queue lock differs')
        fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
        regular(queue/'queue.sqlite3',maximum=67108864,owner=owner,private=True)
        db=sqlite3.connect('file:'+str(queue/'queue.sqlite3')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
        def fence():
            row=db.execute('select * from lease where singleton=1').fetchone()
            require(row and credential.get('candidate')==plan['source'] and row['batch']==credential.get('batch') and row['epoch']==credential.get('epoch'),'Foreign staging lease')
            require(row['phase'] in ('arrived','accepting') and row['build']==plan['buildId'],'Accepted arrival/build required before maintenance')
            require(hmac.compare_digest(row['token_hash'] or '',digest(credential.get('token','').encode())),'Lease credential differs')
            batch=db.execute('select plan,state from batches where id=?',(row['batch'],)).fetchone()
            require(batch and json.loads(batch['plan'])['candidate']==plan['source'] and batch['state']=='leased','Batch source/state differs')
            require(regular(build_file,1024,owner=owner).decode().strip()==plan['buildId'],'Installed build differs')
        try:
            fence();yield fence
        finally: db.close()
    finally: os.close(fd)


def public_health(origin):
    host=urlsplit(origin).hostname;c=http.client.HTTPSConnection(host,443,timeout=15)
    try:
        c.request('GET','/health?aihr_security='+uuid.uuid4().hex,headers={'cache-control':'no-cache','connection':'close'})
        r=c.getresponse();body=r.read(4097);require(r.status==200 and len(body)<=4096,'Public ingress health failed')
    finally: c.close()


def desired_changes(plan,agent,node):
    changes=[(Path(f['path']),base64.b64decode(f['base64']),0o644,f['before']) for f in plan['files']]
    return changes+[(RUNTIME/'agent.cjs',agent,0o644,plan['workerBefore']),(RUNTIME/'node22-security',node,0o755,None),(DROPIN,b'[Service]\nExecStart=\nExecStart=/usr/local/lib/aihr-identity-email/node22-security /usr/local/lib/aihr-identity-email/agent.cjs\n',0o644,None)]


def restore_installed(originals,installed,ports):
    ports['fence']();ports['quiesce']()
    for path,ours in reversed(installed):
        current=ports['read'](path);require(current is not None and digest(current[0])==ours,'Rollback refuses foreign file changes')
        previous=originals[path]
        if previous: ports['write'](path,*previous)
        else: ports['remove'](path)
    ports['restore_services']();ports['record']('rolled-back',None)

def prepare_recovery(changes,ports,metadata):
    """Durably seal every preimage before quiescence or the first target write."""
    files=[]
    for i,(path,value,mode,expected) in enumerate(changes):
        previous=ports['read'](path)
        require((digest(previous[0]) if previous else None)==expected,'Recovery baseline drift')
        if previous: ports['backup'](i,previous[0])
        files.append({'path':str(path),'before':expected,'mode':previous[1] if previous else None,'after':digest(value)})
    recovery={**metadata,'files':files}
    ports['seal'](recovery)
    return recovery

def recover_changes(changes,recovery,ports):
    """Accept any interrupted prefix, including a write before its journal update."""
    require(type(recovery.get('files'))==list and len(recovery['files'])==len(changes),'Complete recovery inventory required')
    originals={};installed=[]
    # Validate the entire baseline/installed set before stopping or changing anything.
    for i,(path,value,mode,expected) in enumerate(changes):
        row=recovery['files'][i]
        require(type(row)==dict and set(row)=={'path','before','mode','after'} and row['path']==str(path) and row['before']==expected and row['after']==digest(value),'Recovery inventory differs')
        if expected is None:
            require(row['mode'] is None,'Unexpected absent baseline mode');originals[path]=None
        else:
            require(type(row['mode'])==int and 0<=row['mode']<=0o777 and row['mode']&0o022==0,'Original file mode differs')
            old=ports['backup_read'](i);require(digest(old)==expected,'Original backup bytes differ');originals[path]=(old,row['mode'])
        current=ports['read'](path);current_hash=digest(current[0]) if current else None
        require(current_hash in (expected,digest(value)),'Recovery refuses foreign file changes')
        if current_hash==digest(value): installed.append((path,digest(value)))
    restore_installed(originals,installed,ports)


def apply_changes(changes, ports):
    """Filesystem transaction used by root adapter and real temporary-file refusal fixtures."""
    originals={};installed=[]
    for path,value,mode,expected in changes:
        previous=ports['read'](path)
        require((digest(previous[0]) if previous else None)==expected,'Maintenance baseline drift')
        originals[path]=previous
    try:
        ports['fence']();ports['record']('preparing',None);ports['prepare']()
        for path,value,mode,expected in changes:
            ports['fence']();current=ports['read'](path)
            require((digest(current[0]) if current else None)==expected,'Maintenance baseline changed before write')
            ports['write'](path,value,mode);installed.append((path,digest(value)));ports['record']('installed',path)
        ports['activate']();ports['verify']()
    except BaseException:
        restore_installed(originals,installed,ports)
        raise


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--plan',required=True);parser.add_argument('--expected-plan-sha256',required=True);parser.add_argument('--lease',required=True);parser.add_argument('--apply',action='store_true');parser.add_argument('--rollback-backup');args=parser.parse_args()
    require(os.geteuid()==0,'Administrator required');trusted_directory(Path(__file__).resolve().parent);regular(Path(__file__).resolve())
    trusted_directory(Path(args.plan).parent);trusted_directory(Path(args.lease).parent)
    raw=regular(args.plan,8388608,private=True);require(digest(raw)==args.expected_plan_sha256,'Private reviewed plan hash differs');plan=validate_plan(json.loads(raw));credential=json.loads(regular(args.lease,4096,private=True))
    agent=base64.b64decode(AGENT_BASE64,validate=True);require(0<len(agent)<=24000000 and digest(agent)==AGENT_SHA256,'Embedded protected bundle differs')
    trusted_directory(NODE_SOURCE.parent)
    node=regular(NODE_SOURCE,134217728);require(digest(node)==NODE_SHA256 and command(str(NODE_SOURCE),'--version')=='v22.23.3','Protected runtime source differs')
    with operation_guard(), lease_guard(credential,plan) as fence:
        if args.rollback_backup:
            require(not args.apply,'Choose apply or rollback, not both');backup=Path(args.rollback_backup)
            require(backup.parent==Path('/var/backups/aihr-security-maintenance') and re.fullmatch('[a-f0-9-]{36}',backup.name),'Known private backup location required');trusted_directory(backup)
            receipt=json.loads(regular(backup/'recovery.json',1048576,private=True))
            require(receipt.get('source')==SOURCE_SHA and receipt.get('planSha256')==digest(raw) and receipt.get('batch')==credential['batch'] and receipt.get('epoch')==credential['epoch'],'Backup source/plan/lease differs')
            require(digest(regular('/etc/aihr-keycloak/email-agent.env',1048576,private=True))==receipt.get('mailEnvironmentSha256'),'Private mail configuration changed before rollback')
            require(stat.S_IMODE(backup.stat().st_mode)==0o700 and receipt.get('kind')=='ROOT_STAGING_SECURITY_MAINTENANCE_NOT_CI_RECEIPT' and receipt.get('buildId')==plan['buildId'],'Unknown private rollback receipt')
            changes=desired_changes(plan,agent,node)
            def read_recovery_target(path):
                trusted_directory(path.parent)
                if not path.exists(): require(not path.is_symlink(),'Dangling recovery target');return None
                return regular(path,134217728),stat.S_IMODE(path.stat().st_mode)
            def restart_previous():
                command('/usr/sbin/nginx','-t');command('/usr/bin/systemctl','reload','nginx');command('/usr/bin/systemctl','daemon-reload');command('/usr/bin/systemctl','start','aihr-identity-email.socket','aihr-identity-email.service')
            recover_changes(changes,receipt,{'backup_read':lambda i:regular(backup/(str(i)+'.before'),134217728,private=True),'fence':fence,'quiesce':lambda:command('/usr/bin/systemctl','stop','aihr-identity-email.socket','aihr-identity-email.service'),'read':read_recovery_target,'write':atomic,'remove':lambda p:p.unlink(),'restore_services':restart_previous,'record':lambda phase,p:atomic(backup/'rollback.json',(json.dumps({'phase':phase,'at':time.time()})+'\n').encode(),0o600)})
            require(capabilities()==receipt['mailCapabilitiesBefore'],'Original mail capabilities not restored');public_health(plan['publicOrigin'])
            print(json.dumps({'kind':'OWNED_SECURITY_MAINTENANCE_ROLLED_BACK','source':SOURCE_SHA,'buildId':plan['buildId'],'backup':str(backup),'retainLease':True}));return
        require(digest(regular(RUNTIME/'agent.cjs'))==plan['workerBefore'],'Protected bundle baseline differs');trusted_directory(RUNTIME)
        require(command('/usr/bin/systemctl','is-active','nginx')=='active','Nginx must already be active');command('/usr/sbin/nginx','-t')
        require(command('/usr/bin/systemctl','show','aihr-identity-email','--property=DropInPaths','--value')=='','Unknown pre-existing mail service overrides')
        before_pid=command('/usr/bin/systemctl','show','aihr-identity-email','--property=MainPID','--value');require(re.fullmatch('[1-9][0-9]*',before_pid) and Path('/proc/'+before_pid+'/exe').resolve()==RUNTIME/'node','Unexpected protected runtime before maintenance')
        before=capabilities();env_hash=digest(regular('/etc/aihr-keycloak/email-agent.env',1048576,private=True))
        require(not DROPIN.exists() and not (RUNTIME/'node22-security').exists(),'Unknown previous security runtime/drop-in')
        if not args.apply:
            print(json.dumps({'kind':'ROOT_MAINTENANCE_PREFLIGHT_ONLY','source':SOURCE_SHA,'planSha256':digest(raw),'files':4,'mailCapabilities':before,'writes':False}));return
        backup=Path('/var/backups/aihr-security-maintenance');backup.mkdir(mode=0o700,exist_ok=True);trusted_directory(backup);require(stat.S_IMODE(backup.stat().st_mode)==0o700,'Private backup custody required')
        backup=backup/str(uuid.uuid4());backup.mkdir(mode=0o700);records=[]
        parent_fd=os.open(backup.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(parent_fd)
        finally: os.close(parent_fd)
        # The drop-in directory is root-owned; its harmless creation grants no service capability.
        DROPIN.parent.mkdir(mode=0o755,exist_ok=True);trusted_directory(DROPIN.parent)
        changes=desired_changes(plan,agent,node)
        def read(path):
            trusted_directory(path.parent)
            if not path.exists(): require(not path.is_symlink(),'Dangling target symlink');return None
            b=regular(path,134217728);return b,stat.S_IMODE(path.stat().st_mode)
        required_space=sum(len(value) for _,value,_,_ in changes)+67108864
        require(all(shutil.disk_usage(parent).free>=required_space for parent in {p.parent for p,_,_,_ in changes}|{backup}),'Insufficient maintenance free space')
        recovery_metadata={'kind':'ROOT_STAGING_SECURITY_MAINTENANCE_NOT_CI_RECEIPT','source':SOURCE_SHA,'buildId':plan['buildId'],'planSha256':digest(raw),'batch':credential['batch'],'epoch':credential['epoch'],'mailEnvironmentSha256':env_hash,'mailCapabilitiesBefore':before}
        fence()
        prepare_recovery(changes,{'read':read,'backup':lambda i,b:atomic(backup/(str(i)+'.before'),b,0o600),'seal':lambda record:atomic(backup/'recovery.json',(json.dumps(record,indent=2)+'\n').encode(),0o600)},recovery_metadata)
        print(json.dumps({'kind':'ROOT_SECURITY_RECOVERY_PREPARED_NOT_ACCEPTED','source':SOURCE_SHA,'backup':str(backup),'retainLease':True}),flush=True)
        def record(phase,path):
            records.append({'phase':phase,'path':str(path) if path else None,'at':time.time()});atomic(backup/'journal.json',(json.dumps(records)+'\n').encode(),0o600)
        def quiesce(): command('/usr/bin/systemctl','stop','aihr-identity-email.socket','aihr-identity-email.service')
        def activate():
            fence();command('/usr/sbin/nginx','-t');command('/usr/bin/systemctl','reload','nginx');command('/usr/bin/systemctl','daemon-reload');command('/usr/bin/systemctl','start','aihr-identity-email.socket','aihr-identity-email.service')
        def verify():
            fence();after_pid=command('/usr/bin/systemctl','show','aihr-identity-email','--property=MainPID','--value');require(re.fullmatch('[1-9][0-9]*',after_pid) and Path('/proc/'+after_pid+'/exe').resolve()==RUNTIME/'node22-security','New protected runtime not active');capabilities_preserved(before,capabilities());require(digest(regular('/etc/aihr-keycloak/email-agent.env',1048576,private=True))==env_hash,'Private mail environment changed');require(digest(regular(RUNTIME/'agent.cjs'))==AGENT_SHA256,'Installed bundle differs');public_health(plan['publicOrigin'])
        def restore_services():
            command('/usr/sbin/nginx','-t');command('/usr/bin/systemctl','reload','nginx');command('/usr/bin/systemctl','daemon-reload');command('/usr/bin/systemctl','start','aihr-identity-email.socket','aihr-identity-email.service')
        fence()
        apply_changes(changes,{'prepare':quiesce,'read':read,'write':atomic,'remove':lambda p:p.unlink(),'fence':fence,'activate':activate,'verify':verify,'quiesce':quiesce,'restore_services':restore_services,'record':record})
        receipt={'kind':'ROOT_STAGING_SECURITY_MAINTENANCE_NOT_CI_RECEIPT','source':SOURCE_SHA,'buildId':plan['buildId'],'planSha256':digest(raw),'agentSha256':AGENT_SHA256,'nodeSha256':NODE_SHA256,'batch':credential['batch'],'epoch':credential['epoch'],'mailCapabilities':capabilities(),'mailCapabilitiesBefore':before,'publicHealthVerified':True,'mailEnvironmentUnchanged':True,'mailEnvironmentSha256':env_hash,'backup':str(backup),'sourceTrustActivated':False,'production':False}
        atomic(backup/'receipt.json',(json.dumps(receipt,indent=2)+'\n').encode(),0o600);print(json.dumps(receipt))

if __name__=='__main__':
    try: main()
    except (ValueError,TypeError,KeyError,OSError,sqlite3.Error,subprocess.SubprocessError,http.client.HTTPException):
        print('Security maintenance refused or failed; retain the lease and inspect the private rollback journal. No credentials printed.',file=sys.stderr);sys.exit(1)

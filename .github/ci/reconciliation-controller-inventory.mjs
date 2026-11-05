/** Exact reviewed executable bytes, safe paths and metadata for the private recovery controller. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {installHash,installJson} from './ci-install-grant.mjs';
const safe=p=>typeof p==='string'&&/^[A-Za-z0-9_./-]+$/.test(p)&&!p.startsWith('/')&&p.split('/').every(v=>v&&v!=='.'&&v!=='..');
/** Runs trusted inline stdlib code before Node imports any uploaded executable. */
export function controllerLaunchCheck(root,digest){
 assert(/^\/[A-Za-z0-9_./-]+$/.test(root)&&!root.split('/').some(v=>v==='.'||v==='..')&&/^[a-f0-9]{64}$/.test(digest),'Exact private launch inventory required');
 return `python3 - '${root}' '${digest}' <<'AIHR_CONTROLLER_INVENTORY'
import os,sys,stat,json,hashlib
root,expected=sys.argv[1:]
def require(v):
 if not v: raise ValueError('Private reviewed executable inventory differs')
require(os.path.realpath(root)==root)
st=os.lstat(root);require(stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700)
def read(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and s.st_size<=16777216)
  with os.fdopen(os.dup(fd),'rb') as stream: data=stream.read(16777217)
  require(len(data)==s.st_size);return data,s
 finally:os.close(fd)
raw,_=read(root+'/controller-inventory.json');require(raw.endswith(b'\\n') and hashlib.sha256(raw[:-1]).hexdigest()==expected)
m=json.loads(raw);require(m['format']==1 and m['kind']=='REVIEWED_PRIVATE_RECONCILIATION_EXECUTABLE_INVENTORY')
entries={e['path']:e for e in m['entries']};require(len(entries)==len(m['entries']) and 0<len(entries)<2000)
found=set();total=0
for base,dirs,files in os.walk(root,followlinks=False):
 for name in dirs:
  s=os.lstat(base+'/'+name);require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o022)
 for name in files:
  path=base+'/'+name;relative=os.path.relpath(path,root)
  data,s=read(path)
  if relative=='controller-inventory.json':require(data==raw);continue
  require(relative in entries);e=entries[relative]
  require(len(data)==e['bytes'] and stat.S_IMODE(s.st_mode)==e['mode'] and hashlib.sha256(data).hexdigest()==e['sha256'])
  total+=len(data);require(total<=67108864);found.add(relative)
require(found==set(entries))
AIHR_CONTROLLER_INVENTORY
`;
}
export function controllerInventoryEntry(path,bytes,mode=0o644){assert(safe(path)&&[0o600,0o644,0o755].includes(mode),'Safe executable inventory entry required');return {path,bytes:bytes.length,sha256:installHash(bytes),mode};}
export function assertControllerInventory(root,m,{expectedSha256}={}){
 assert(m?.format===1&&m.kind==='REVIEWED_PRIVATE_RECONCILIATION_EXECUTABLE_INVENTORY'&&/^[a-f0-9]{40}$/.test(m.controller)&&Array.isArray(m.entries)&&m.entries.length>0&&m.entries.length<2000,'Exact bounded reviewed controller inventory required');
 assert(Object.keys(m).sort().join(',')==='controller,entries,format,kind'&&(!expectedSha256||installHash(installJson(m))===expectedSha256),'Reviewed controller manifest differs');
 const s=lstatSync(root);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(root)===root&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'Canonical private controller root required');
 const wanted=new Map();for(const e of m.entries){assert(Object.keys(e).sort().join(',')==='bytes,mode,path,sha256'&&safe(e.path)&&e.path!=='controller-inventory.json'&&[0o600,0o644,0o755].includes(e.mode)&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&e.bytes<=16*1024**2&&/^[a-f0-9]{64}$/.test(e.sha256)&&!wanted.has(e.path),'Unique bounded executable inventory entries required');wanted.set(e.path,e);}
 const rows=[],found=[];let total=0;
 function walk(relative=''){
  const path=relative?join(root,relative):root,st=lstatSync(path,{bigint:true});assert(!st.isSymbolicLink()&&st.uid===BigInt(process.getuid()),'Controller symlink or foreign owner refused');
  rows.push([relative,...['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(st[k]))]);
  if(st.isDirectory()){assert((Number(st.mode)&0o022)===0,'Writable controller directory refused');for(const name of readdirSync(path).sort())walk(relative?relative+'/'+name:name);return;}
  assert(st.isFile()&&st.nlink===1n,'Controller executable must be a single-link regular file');
  if(relative==='controller-inventory.json'){assert(st.size<=1024n*1024n&&installHash(readFileSync(path))===installHash(installJson(m)+'\n'),'Immutable reviewed inventory bytes differ');return;}
  const e=wanted.get(relative);assert(e&&Number(st.size)===e.bytes&&(Number(st.mode)&0o777)===e.mode,'Unexpected executable path/size/mode');total+=e.bytes;assert(total<=64*1024**2,'Controller executable bytes exceed bound');assert(installHash(readFileSync(path))===e.sha256,'Reviewed executable bytes changed');found.push(relative);
 }walk();assert(installJson(found.sort())===installJson([...wanted.keys()].sort()),'Reviewed executable inventory incomplete');return installHash(installJson(rows));
}

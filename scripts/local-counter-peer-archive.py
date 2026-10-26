"""Authenticate bounded JSON-only historical members without extracting/executing them."""
import hashlib,json,pathlib,re,stat,sys,zipfile
root=pathlib.Path(sys.argv[1]);assert root.resolve()==root and root.is_dir()
items=json.load(sys.stdin);assert len(items)==25
proof=[]
for item in items:
    name=item['name'];assert re.fullmatch(r'[A-Za-z0-9_.-]+',name)
    p=root/(name+'.zip');assert p.is_file() and not p.is_symlink() and p.resolve()==p
    raw=p.read_bytes();assert len(raw)==item['size_in_bytes'] and len(raw)<=64*1024**2
    digest=hashlib.sha256(raw).hexdigest();assert 'sha256:'+digest==item['digest']
    proof.append({'path':name+'.zip','bytes':len(raw),'sha256':digest})
    with zipfile.ZipFile(p) as z:
        entries=z.infolist();assert 0<len(entries)<=100 and sum(i.file_size for i in entries)<=128*1024**2
        seen=set()
        for i in entries:
            assert re.fullmatch(r'[A-Za-z0-9_.-]+\.json',i.filename) and i.filename not in seen
            seen.add(i.filename)
            assert not i.is_dir() and not (i.flag_bits&1) and not stat.S_ISLNK(i.external_attr>>16) and 0<i.file_size<=64*1024**2
            data=z.read(i);target=root/name/i.filename
            assert target.is_file() and not target.is_symlink() and target.resolve()==target and target.read_bytes()==data
            proof.append({'path':name+'/'+i.filename,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
print(json.dumps(proof))

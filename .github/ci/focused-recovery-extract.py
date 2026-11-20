"""Extract only recovery JSON; retain bounded screenshot attachments solely in the original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
results={'focused.json','nodb.vitest.json','db.vitest.json'}
diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
role='personnel-draft-discard-premigration-role-prerequisites.json'
runtime_role='personnel-draft-discard-role-prerequisites.json'
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Focused artifact exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in results|diagnostics|{role,runtime_role} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown focused artifact member')
        if i.file_size>(64*1024*1024 if i.filename in results else 10*1024*1024):
            raise ValueError('Focused artifact member exceeds bounds')
        names.add(i.filename)
    if 'focused.json' not in names:
        raise ValueError('Focused recovery JSON missing')
    report=json.loads(z.read('focused.json'))
    database=bool(report.get('groups',{}).get('DB'))
    if bool(report.get('groups',{}).get('NODB'))==database:
        raise ValueError('One homogeneous recovery partition required')
    result='db.vitest.json' if database else 'nodb.vitest.json'
    other='nodb.vitest.json' if database else 'db.vitest.json'
    if result not in names or other in names:
        raise ValueError('Focused result partition differs')
    if database and not diagnostics.issubset(names) or not database and (diagnostics|{role,runtime_role}).intersection(names):
        raise ValueError('Database diagnostics differ')
    if (role in names)!=(runtime_role in names):
        raise ValueError('Incomplete disposable role receipts')
    required={'focused.json',result}|({role,runtime_role} if role in names else set())
    destination.mkdir(mode=0o700)
    for name in sorted(required):
        with (destination/name).open('xb') as out:
            out.write(z.read(name))

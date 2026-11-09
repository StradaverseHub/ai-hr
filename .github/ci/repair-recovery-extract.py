"""v2 homogeneous focused packet; diagnostics stay bounded in the immutable original ZIP."""
import json,pathlib,re,stat,sys,zipfile
if len(sys.argv) not in (3,4) or len(sys.argv)==4 and sys.argv[3]!='--exact-db':
    raise ValueError('Unexpected repair packet mode')
archive,destination=map(pathlib.Path,sys.argv[1:3])
exact_db=len(sys.argv)==4
role_members={'personnel-draft-discard-premigration-role-prerequisites.json','personnel-draft-discard-role-prerequisites.json'}
label_diagnostics={'system-label-browser-resources.json','system-label-browser-results.json','system-label-browser-server.log'}
label_images=r'system-label-(?:exchange-(?:en|ms|zh|ta|th|vi)-(?:desktop|mobile)|preview-en-desktop|profile-options-empty|restricted-global-refusal)\.png'
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if exact_db:
            allowed=allowed or i.filename in role_members|label_diagnostics or re.fullmatch(label_images,i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.file_size>(64*1024*1024 if i.filename in {'focused.json','nodb.vitest.json','db.vitest.json'} else 16*1024*1024):
            raise ValueError('Repair member exceeds bound')
        names.add(i.filename)
    if 'focused.json' not in names:
        raise ValueError('Focused identity missing')
    report=json.loads(z.read('focused.json'))
    groups=report.get('groups',{})
    database=bool(groups.get('DB'))
    if bool(groups.get('NODB'))==database:
        raise ValueError('One homogeneous repair partition required')
    result='db.vitest.json' if database else 'nodb.vitest.json'
    if result not in names or ('nodb.vitest.json' if database else 'db.vitest.json') in names:
        raise ValueError('Result partition differs')
    diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
    if database and not diagnostics.issubset(names) or not database and diagnostics.intersection(names):
        raise ValueError('Database diagnostics differ')
    retained_roles=role_members.intersection(names)
    if exact_db and (not database or retained_roles and retained_roles!=role_members):
        raise ValueError('Exact database recovery packet or complete role evidence required')
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}|retained_roles):
        with (destination/name).open('xb') as out:out.write(z.read(name))

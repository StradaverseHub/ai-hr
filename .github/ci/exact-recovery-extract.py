"""v3 closed focused packet; bounded identity-checked setup diagnostics stay in the original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
prerequisites={'personnel-draft-discard-premigration-role-prerequisites.json':'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES','personnel-draft-discard-role-prerequisites.json':'PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES'}
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or i.filename in prerequisites or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.filename in prerequisites and i.file_size>65536:
            raise ValueError('Setup diagnostic exceeds bound')
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
    present=set(prerequisites).intersection(names)
    if present and (not database or present!=set(prerequisites)):
        raise ValueError('Paired DB setup diagnostics required')
    for name in present:
        item=json.loads(z.read(name))
        if item.get('kind')!=prerequisites[name] or any(item.get(k)!=report.get(v) for k,v in [('candidate','sha'),('controller','controller'),('runId','runId')]):
            raise ValueError('Setup diagnostic identity differs')
        if name.startswith('personnel-draft-discard-premigration') and item.get('attempt')!=report.get('attempt'):
            raise ValueError('Setup diagnostic attempt differs')
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}):
        with (destination/name).open('xb') as out:out.write(z.read(name))

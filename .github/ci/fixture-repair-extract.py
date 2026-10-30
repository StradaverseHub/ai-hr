"""Finite fixture homogeneous focused packet; diagnostics stay bounded in the immutable original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    duration={f'duration-sequence-smoke/{n}' for n in ['baseline.sequence.json','baseline.log','baseline.vitest.json','duration.log','duration.sequence.json','duration.vitest.json','proof.json']}
    for i in entries:
        allowed=i.filename=='worker-cross-version.json' or i.filename in duration or i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_IFMT(i.external_attr>>16) not in (0,stat.S_IFREG) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.file_size>(64*1024*1024 if i.filename in {'focused.json','nodb.vitest.json','db.vitest.json'} else 16*1024*1024):
            raise ValueError('Repair member exceeds bound')
        names.add(i.filename)
    if names.intersection(duration) and not duration.issubset(names):raise ValueError('Incomplete duration diagnostic inventory')
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
    if database and names.intersection(duration):raise ValueError('Duration diagnostic belongs to Node partition only')
    if not database and 'worker-cross-version.json' in names:raise ValueError('Worker diagnostic belongs to DB partition only')
    diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
    if database and not diagnostics.issubset(names) or not database and diagnostics.intersection(names):
        raise ValueError('Database diagnostics differ')
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}):
        with (destination/name).open('xb') as out:out.write(z.read(name))

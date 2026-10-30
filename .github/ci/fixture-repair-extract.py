"""Finite fixture homogeneous focused packet; diagnostics stay bounded in the immutable original ZIP."""
import hashlib,json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
if archive.stat().st_size>64*1024*1024:raise ValueError('Repair archive exceeds bound')
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    duration={f'duration-sequence-smoke/{n}' for n in ['baseline.sequence.json','baseline.log','baseline.vitest.json','duration.log','duration.sequence.json','duration.vitest.json','proof.json']}
    letters={f'letter-pdf-fixtures/fictional-letter-{lang}.pdf' for lang in ['en','ms','ta','th','vi','zh']} | {'letter-report-fixtures/fictional-report.pdf','letter-report-fixtures/fictional-report.xlsx','private-workflow-email-upgrade/manifest.json','private-workflow-email-upgrade/workflow-upgrade.cjs'}
    finite_sizes={('postgres.log',16779562):'8f64b55071ae7b4ca2ed4fd19eb2afcc9e4611c3d0831bb6010d4bb5ff66b9bf',('private-workflow-email-upgrade/workflow-upgrade.cjs',31074589):'4ede85b1899e9d4340a222c94efd7e1a64bea636eb5ed7e10209cb1449c5c69d'}
    archive_hash=None
    for i in entries:
        allowed=i.filename in letters or i.filename=='worker-cross-version.json' or i.filename in duration or i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_IFMT(i.external_attr>>16) not in (0,stat.S_IFREG) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.file_size>(64*1024*1024 if i.filename in {'focused.json','nodb.vitest.json','db.vitest.json'} else 16*1024*1024):
            if archive_hash is None:archive_hash=hashlib.sha256(archive.read_bytes()).hexdigest()
            if finite_sizes.get((i.filename,i.file_size))!=archive_hash:raise ValueError('Repair member exceeds bound')
        names.add(i.filename)
    if names.intersection(letters) and not letters.issubset(names):raise ValueError('Incomplete letter diagnostic inventory')
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
    if database and names.intersection(letters):raise ValueError('Letter diagnostic belongs to Node partition only')
    if database and names.intersection(duration):raise ValueError('Duration diagnostic belongs to Node partition only')
    if not database and 'worker-cross-version.json' in names:raise ValueError('Worker diagnostic belongs to DB partition only')
    diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
    if database and not diagnostics.issubset(names) or not database and diagnostics.intersection(names):
        raise ValueError('Database diagnostics differ')
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}):
        with (destination/name).open('xb') as out:out.write(z.read(name))

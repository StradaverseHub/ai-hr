"""v3 homogeneous focused packet; diagnostics stay bounded in the immutable original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    role_diagnostics={'personnel-draft-discard-premigration-role-prerequisites.json','personnel-draft-discard-role-prerequisites.json'}
    worker_diagnostics={'worker-cross-version-legacy.json':'968354c00a71df7baccd499eb60757a3307ed61e','worker-cross-version-staged.json':'a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac'}
    names=set()
    for i in entries:
        allowed=i.filename in worker_diagnostics or i.filename in role_diagnostics or i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.filename in (role_diagnostics|worker_diagnostics.keys()) and i.file_size>32*1024:
            raise ValueError('Closed diagnostic exceeds bound')
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
    if not database and role_diagnostics.intersection(names):
        raise ValueError('Role prerequisites require database partition')
    compatibility=database and 'test/ai-review-worker-compatibility.test.ts' in report.get('files',[])
    workers=set(worker_diagnostics).intersection(names)
    if workers != (set(worker_diagnostics) if compatibility else set()):
        raise ValueError('Exact compatibility diagnostic pair and selection required')
    for name in sorted(workers):
        payload=json.loads(z.read(name))
        if not isinstance(payload,dict) or payload.get('kind')!='GIT_SOURCE_CROSS_VERSION_FIXTURE_NOT_PACKET_OR_LIVE_ACCEPTANCE' or payload.get('workerSource')!=worker_diagnostics[name] or payload.get('webSource')!=report.get('sha') or not re.fullmatch(r'[a-f0-9]{40}',str(report.get('sha',''))):
            raise ValueError('Compatibility diagnostic source identity differs')
        if payload.get('reviewedHistoricalBaseline')!='a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac' or payload.get('matchingWorkerRequired') is not True or payload.get('authenticatedCorrectedPacketProofRequired') is not True:
            raise ValueError('Compatibility diagnostic custody differs')
        if any(payload.get(k) is not False for k in ['actualPacketExecuted','protectedServiceVerified','liveRestartVerified','deploymentAuthorized']):
            raise ValueError('Compatibility diagnostic overclaims authority')
        if any(payload.get(k) is not True for k in ['newWebAdmission','humanCommandFixture','canonicalWrite','tenantDenial','newProcessReplay']) or payload.get('historyItems')!=1 or not isinstance(payload.get('schemaEntries'),int) or isinstance(payload.get('schemaEntries'),bool) or payload['schemaEntries']<563 or not re.fullmatch(r'[a-f0-9]{64}',str(payload.get('sourceArchiveSha256',''))):
            raise ValueError('Compatibility diagnostic observation shape differs')
    # These are original diagnostics, never replacement assertions or extracted authority.
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}):
        with (destination/name).open('xb') as out:out.write(z.read(name))

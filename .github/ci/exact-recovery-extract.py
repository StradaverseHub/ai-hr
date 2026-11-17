"""v4 closed focused packet; declared bounded diagnostics remain in the authenticated original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
prerequisites={'personnel-draft-discard-premigration-role-prerequisites.json':'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES','personnel-draft-discard-role-prerequisites.json':'PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES'}
source_diagnostics={'claims-approval-queue-100k.json':('test/claims-approval-queue-scale.test.ts','CLAIMS_APPROVAL_QUEUE_SCALE_V1'),'personnel-page-projection.json':('test/personnel-page-projection.test.ts','NATIVE_PERSONNEL_PROJECTION_COUNT_NOT_SYSTEM_CAPACITY')}
label_fixed={'system-label-browser-resources.json','system-label-browser-results.json','system-label-browser-server.log','system-label-preview-en-desktop.png','system-label-profile-options-empty.png','system-label-restricted-global-refusal.png'}
def label_diagnostic(name):
    return name in label_fixed or re.fullmatch(r'system-label-dev-server-heap/heap-[1-9][0-9]*\.json',name) or re.fullmatch(r'system-label-exchange-(en|ms|ta|th|vi|zh)-(mobile|desktop)\.png',name)
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    for i in entries:
        profile=re.fullmatch(r'harness-profile/profile-[0-9]+-[A-Za-z0-9_-]+\.jsonl',i.filename)
        allowed=i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt','profile-summary.json','analytics-carry-searched-native-50k.json'} or i.filename in prerequisites or i.filename in source_diagnostics or label_diagnostic(i.filename) or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename) or profile
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.filename in prerequisites and i.file_size>65536:
            raise ValueError('Setup diagnostic exceeds bound')
        if i.filename=='analytics-carry-searched-native-50k.json' and i.file_size>65536:
            raise ValueError('Carry diagnostic exceeds original receipt bound')
        if i.filename in source_diagnostics and i.file_size>65536:
            raise ValueError('Selected-source diagnostic exceeds bound')
        if label_diagnostic(i.filename) and i.filename.endswith('.json') and i.file_size>65536:
            raise ValueError('System Labels diagnostic exceeds bound')
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
    labels={n for n in names if label_diagnostic(n)}
    if labels and (not database or 'test/system-label-exchange-browser.test.ts' not in groups['DB']):
        raise ValueError('System Labels diagnostic is not declared by selected source')
    if 'system-label-browser-results.json' in names:
        label_result=json.loads(z.read('system-label-browser-results.json'))
        if label_result.get('source')!=report.get('sha'):
            raise ValueError('System Labels diagnostic source differs')
    diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
    if database and not diagnostics.issubset(names) or not database and diagnostics.intersection(names):
        raise ValueError('Database diagnostics differ')
    profiling={'profile-summary.json'}|{n for n in names if n.startswith('harness-profile/')}
    if not database and (profiling.intersection(names) or 'analytics-carry-searched-native-50k.json' in names):
        raise ValueError('Database-only diagnostic on no-database process')
    for name in set(source_diagnostics).intersection(names):
        selected,kind=source_diagnostics[name]
        value=json.loads(z.read(name))
        if not database or selected not in groups['DB'] or value.get('kind')!=kind:
            raise ValueError('Diagnostic is not declared by the selected source')
    if 'test/analytics-carry-searched-native-scale.test.ts' in groups.get('DB',[]) and 'analytics-carry-searched-native-50k.json' not in names:
        raise ValueError('Selected Carry source diagnostic missing')
    if 'analytics-carry-searched-native-50k.json' in names:
        receipt=json.loads(z.read('analytics-carry-searched-native-50k.json'))
        if 'test/analytics-carry-searched-native-scale.test.ts' not in groups['DB'] or receipt.get('kind')!='SEARCHED_CARRY_50000_NATIVE_COMPONENT':
            raise ValueError('Carry diagnostic is not declared by selected source')
        if report.get('exitCode')==0 and (receipt.get('status')!='COMPLETE' or receipt.get('settlement')!='CONFIRMED' or receipt.get('observedBackends')!=4):
            raise ValueError('Successful Carry result requires complete settled native diagnostic')
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

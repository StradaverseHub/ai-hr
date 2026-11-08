"""v2 homogeneous focused packet; diagnostics stay bounded in the immutable original ZIP."""
import json,pathlib,re,stat,sys,zipfile
if len(sys.argv) not in (3,4) or len(sys.argv)==4 and sys.argv[3]!='--six-metadata-profile':
    raise ValueError('Unknown repair extractor mode')
metadata=len(sys.argv)==4
archive,destination=map(pathlib.Path,sys.argv[1:3])
prerequisites={'personnel-draft-discard-premigration-role-prerequisites.json','personnel-draft-discard-role-prerequisites.json'}
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Repair packet exceeds bounds')
    names=set()
    for i in entries:
        allowed=(metadata and i.filename in prerequisites) or i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown repair member')
        if i.file_size>(64*1024*1024 if i.filename in {'focused.json','nodb.vitest.json','db.vitest.json'} else 16*1024*1024):
            raise ValueError('Repair member exceeds bound')
        if i.filename in prerequisites and i.file_size>1024*1024:
            raise ValueError('Prerequisite diagnostic exceeds bound')
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
    if metadata:
        if database and not prerequisites.issubset(names) or not database and prerequisites.intersection(names):
            raise ValueError('Metadata prerequisite diagnostic partition differs')
        if report.get('sha')!='e70686353134de3471f08fe7a27e937f14fdcc95' or report.get('controller')!='df32d8955525e991f42b31eca2a8fbfd71dcbaa2' or report.get('attempt')!='1':
            raise ValueError('Foreign metadata repair packet')
        for name in prerequisites if database else []:
            proof=json.loads(z.read(name))
            if proof.get('candidate')!=report['sha'] or proof.get('controller')!=report['controller'] or proof.get('runId')!=report.get('runId') or proof.get('helperSha256')!='32aaff3dc2f8a80bfe3e69769422b234e0f607a5dad7c0f4b4cb27e5946a3c54':
                raise ValueError('Unbound prerequisite diagnostic')
            expected='PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES' if 'premigration' in name else 'PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES'
            fixture=proof.get('fixture') if 'premigration' in name else proof
            if proof.get('kind')!=expected or not isinstance(fixture,dict) or fixture.get('mode')!='focused_disposable' or fixture.get('postgres',{}).get('versionNumber',0)//10000!=16:
                raise ValueError('Foreign prerequisite mode or runtime')
            if 'premigration' in name and (proof.get('attempt')!='1' or proof.get('phase')!='before_initial_candidate_migration' or proof.get('wrapperSha256')!='3050abc60faa490cdab416f9aeffc80b0b042daf3891ce2e34fbb42071bc7eec' or proof.get('orchestrationSha256')!='61f528c2570c90204e739a37652e7e79d6c3fc5905bbf849209d20c66709492a'):
                raise ValueError('Foreign premigration producer')
    destination.mkdir(mode=0o700)
    for name in sorted({'focused.json',result}):
        with (destination/name).open('xb') as out:out.write(z.read(name))

"""Extract only recovery JSON; retain bounded screenshot attachments solely in the original ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
results={'focused.json','nodb.vitest.json','db.vitest.json'}
diagnostics={'postgres.log','postgres-state.json','postgres-stats.txt'}
role='personnel-draft-discard-premigration-role-prerequisites.json'
runtime_role='personnel-draft-discard-role-prerequisites.json'
visual_file='test/operational-visual-browser.test.ts'
visual_routes=(
    'admin-settings-system-labels','roster','rewards','admin-personnel','attendance-daily',
    'payroll','me','claims','approvals','leave','leave-employee-balances','leave-employee-records',
    'reports','reports-employee-master-new','recruitment','analytics','admin-settings-people','today',
)
visual_images={f'operational-{route}-{device}.png' for route in visual_routes for device in ('desktop','mobile')}
visual_bottoms={name.removesuffix('.png')+'-bottom.png' for name in visual_images}
visual_guidance={f'operational-label-guidance-{device}.png' for device in ('desktop','mobile')}
visual_json={'operational-authenticated-visual-results.json','operational-overflow-results.json','operational-visual-progress.json'}
def visual_attachment(name):
    return (name in visual_images|visual_bottoms|visual_guidance|visual_json|{'operational-preview.log'}
        or re.fullmatch(r'operational-preview-heap/heap-[1-9][0-9]*\.json',name))

with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>384 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Focused artifact exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in results|diagnostics|{role,runtime_role} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename) or visual_attachment(i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown focused artifact member')
        if i.file_size>(64*1024*1024 if i.filename in results else 10*1024*1024):
            raise ValueError('Focused artifact member exceeds bounds')
        names.add(i.filename)
    if 'focused.json' not in names:
        raise ValueError('Focused recovery JSON missing')
    report=json.loads(z.read('focused.json'))
    database=bool(report.get('groups',{}).get('DB'))
    visual=database and report['groups']['DB']==[visual_file] and report.get('files')==[visual_file]
    if any(visual_attachment(name) for name in names) and not visual:
        raise ValueError('Operational visual attachments require the isolated visual unit')
    if visual:
        required_visual=visual_images|visual_guidance|visual_json
        if not required_visual.issubset(names):
            raise ValueError('Incomplete operational visual evidence')
        for name in names & (visual_images|visual_bottoms|visual_guidance):
            with z.open(name) as image:
                if image.read(8)!=b'\x89PNG\r\n\x1a\n':
                    raise ValueError('Invalid operational screenshot')
    # Keep the database limit. No-DB browser fixtures retain up to 384
    # archive members, with the same byte bounds and no screenshot extraction.
    if database and len(entries)>128:
        raise ValueError('Focused database artifact exceeds member bound')
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
    if visual:
        required|=visual_json-{'operational-visual-progress.json'}
    destination.mkdir(mode=0o700)
    for name in sorted(required):
        with (destination/name).open('xb') as out:
            out.write(z.read(name))

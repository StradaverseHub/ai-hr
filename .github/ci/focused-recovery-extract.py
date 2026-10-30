"""Extract only recovery JSON; retain bounded screenshot attachments solely in the original ZIP."""
import pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
required={'focused.json','nodb.vitest.json'}
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Focused artifact exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in required or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown focused artifact member')
        if i.file_size>(64*1024*1024 if i.filename in required else 10*1024*1024):
            raise ValueError('Focused artifact member exceeds bounds')
        names.add(i.filename)
    if not required.issubset(names):
        raise ValueError('Focused recovery JSON missing')
    destination.mkdir(mode=0o700)
    for name in sorted(required):
        with (destination/name).open('xb') as out:
            out.write(z.read(name))

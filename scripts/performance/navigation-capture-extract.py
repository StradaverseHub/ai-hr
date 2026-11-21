"""Extract only fixed development capture JSON, never execute archive contents."""
import os, pathlib, stat, sys, zipfile
archive, destination = map(pathlib.Path, sys.argv[1:])
required = {'navigation-browser-capture.json', 'runner.json', 'http-browser.json'}
# The performance artifact also contains profiler/log files. Inventory everything safely,
# but extract only the three fixed JSON members into a new private directory.
destination.mkdir(mode=0o700)
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries) > 4096 or sum(i.file_size for i in entries) > 256*1024*1024:
        raise ValueError('Development capture archive exceeds bounds')
    names, selected = set(), {}
    for i in entries:
        path = pathlib.PurePosixPath(i.filename)
        mode = i.external_attr >> 16
        if ('\\' in i.filename or path.is_absolute() or '..' in path.parts or
                '.' in path.parts or not i.filename or i.filename in names or
                stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise ValueError('Unsafe or duplicate development capture member')
        names.add(i.filename)
        if not i.is_dir() and path.name in required:
            if i.filename != path.name or path.name in selected or i.file_size > 16*1024*1024:
                raise ValueError('Ambiguous or oversized development capture JSON')
            selected[path.name] = i
    if set(selected) != required:
        raise ValueError('Missing development capture JSON')
    for name, member in selected.items():
        fd = os.open(destination/name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(z.read(member))

"""Download only bytes named by committed manifests; never execute remote code."""
import hashlib,json,pathlib,sys,urllib.request
mode,destination=sys.argv[1:];root=pathlib.Path(destination);root.mkdir(parents=True,exist_ok=True)
resources=pathlib.Path(__file__).parent
if mode=='model':
    m=json.loads((resources/'model-manifest.json').read_text());files=[dict(name=n,**v,url=f'https://huggingface.co/{m["model"]}/resolve/{m["revision"]}/{n}') for n,v in m['files'].items()]
elif mode=='mac':
    m=json.loads((resources/'mac-bundle.json').read_text());files=m['files']
elif mode=='cpu':
    files=json.loads((resources/'cpu-wheels.json').read_text())['files']
else:raise ValueError('Choose cpu, mac or model')
for f in files:
    p=root/f['name'];p.parent.mkdir(parents=True,exist_ok=True)
    if p.exists() and p.stat().st_size==f['bytes'] and hashlib.sha256(p.read_bytes()).hexdigest()==f['sha256']:continue
    temporary=p.with_name(p.name+'.pending');h=hashlib.sha256();total=0
    try:
        with urllib.request.urlopen(f['url'],timeout=90) as response,temporary.open('wb') as out:
            while data:=response.read(1024*1024):
                total+=len(data)
                if total>f['bytes']:raise ValueError('Download exceeds manifest length')
                h.update(data);out.write(data)
        if total!=f['bytes'] or h.hexdigest()!=f['sha256']:raise ValueError('Download integrity mismatch: '+f['name'])
        temporary.replace(p);print('Prepared '+f['name'],flush=True)
    finally:temporary.unlink(missing_ok=True)

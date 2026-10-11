"""Bounded CPU recovery trial in fresh processes; corrupt candidates stay host-rejected."""
import json,sys,subprocess,importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location('recipe','/recipe/train.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
config=json.loads(Path('/input/config.json').read_text());root=Path('/output');identity=sys.argv[1]
if len(sys.argv)>2:
    stage=sys.argv[2]
    resume=json.loads((root/'partial.json').read_text()) if stage=='resumed' else None
    point=m.train(config,root/stage,identity,resume=resume,stop_after=21 if stage=='partial' else None)
    (root/(stage+'.json')).write_text(json.dumps(point))
else:
    for stage in ['full','partial','resumed']:
        subprocess.run([sys.executable,__file__,identity,stage],check=True)
    assert json.loads((root/'full.json').read_text())==json.loads((root/'resumed.json').read_text()), 'Recovery changed complete state'
    assert (root/'full/model.json').read_bytes()==(root/'resumed/model.json').read_bytes(), 'Recovery changed model bytes'

"""Generate inert fixtures inside the pinned offline CPU image with /recipe/train.py."""
import importlib.util,json,tempfile,torch
assert torch.__version__ == "2.14.0+cpu"
from pathlib import Path
s=importlib.util.spec_from_file_location('recipe','/recipe/train.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for kind,steps in [('classifier',21),('kmeans',5)]:
    spec={'version':1,'title':'Checkpoint fixture','kind':kind,'seed':42,'steps':45,'batchSize':7,'learningRate':0.01,'clusters':2,'maxError':0.2,'limits':{'timeoutSeconds':60,'totalSeconds':240,'maxAttempts':4}}
    config={'context':'checkpoint-fixture-v1','spec':spec,'rows':[{'id':str(i),'x':[i/20,(i%7)/7],**({'y':int(i>=20)} if kind=='classifier' else {})} for i in range(40)],'means':[1,0.4],'scales':[0.5,0.3]}
    with tempfile.TemporaryDirectory() as d:
        checkpoint=m.train(config,d,'fixture-job',stop_after=steps)
        Path('/fixtures/'+kind+'.json').write_text(json.dumps({'binding':{'features':2,'trainingRows':40,'spec':spec},'checkpoint':checkpoint},separators=(',',':'))+'\n')

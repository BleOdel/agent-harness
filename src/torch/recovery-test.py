"""Run inside the pinned CPU image; use fresh processes across checkpoints."""
import importlib.util,json,subprocess,sys,tempfile
from pathlib import Path
module=Path(__file__).with_name('train.py')
spec=importlib.util.spec_from_file_location('recipe',module);recipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(recipe)

def config(kind):
    rows=[{'id':str(i),'x':[i/20,(i%7)/7],**({'y':int(i>=20)} if kind=='classifier' else {})} for i in range(40)]
    return {'context':'fixed-data-and-settings','spec':{'kind':kind,'seed':42,'steps':45,'batchSize':7,'learningRate':0.01,'clusters':2},'rows':rows,'means':[1,0.4],'scales':[0.5,0.3]}

if len(sys.argv)>1:
    root=Path(sys.argv[1]);kind=sys.argv[2];stage=sys.argv[3];resume=json.loads((root/'checkpoint.json').read_text()) if stage=='resume' else None
    recipe.train(config(kind),root,'fixed-job',resume,19 if stage=='partial' else None)
else:
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp)
        for kind in ['classifier','kmeans']:
            full=root/(kind+'-full');split=root/(kind+'-split')
            for path,stage in [(full,'full'),(split,'partial'),(split,'resume')]:subprocess.run([sys.executable,__file__,str(path),kind,stage],check=True)
            a=json.loads((full/'checkpoint.json').read_text());b=json.loads((split/'checkpoint.json').read_text())
            assert a==b, 'Recovery changed complete training state'
            assert (full/'model.json').read_bytes()==(split/'model.json').read_bytes()
            print(kind+': exact complete checkpoint, loss trajectory and model recovery',flush=True)
        # An optimizer-reset mutation must diverge, proving weights-only recovery is inadequate.
        broken=root/'broken';subprocess.run([sys.executable,__file__,str(broken),'classifier','partial'],check=True)
        p=json.loads((broken/'checkpoint.json').read_text());state=p['payload']['optimizer']['dict'];next(v for k,v in state if k=='state')['dict']=[]
        recipe.atomic(broken/'checkpoint.json',p);subprocess.run([sys.executable,__file__,str(broken),'classifier','resume'],check=True)
        assert (broken/'checkpoint.json').read_bytes()!=(root/'classifier-full'/'checkpoint.json').read_bytes(), 'Mutation escaped recovery comparison'
        print('Optimizer-reset mutation detected',flush=True)

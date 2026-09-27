import json
from pathlib import Path
import torch

torch.set_num_threads(1)
p=json.loads(Path('/work/input.json').read_text());m=p['model']
x=(torch.tensor(p['features'],dtype=torch.float32)-torch.tensor(p['means']))/torch.tensor(p['scales'])
with torch.no_grad():
    if m['kind']=='classifier':
        model=torch.nn.Sequential(torch.nn.Linear(x.shape[1],16),torch.nn.ReLU(),torch.nn.Dropout(0.2),torch.nn.Linear(16,8),torch.nn.ReLU(),torch.nn.Linear(8,2));model.load_state_dict({k:torch.tensor(v,dtype=torch.float32) for k,v in m['weights'].items()});model.eval();predictions=model(x).argmax(1).tolist()
    else:predictions=torch.cdist(x,torch.tensor(m['centers'],dtype=torch.float32)).square().min(1).values.tolist()
print(json.dumps({'predictions':predictions},allow_nan=False))

import json,platform,traceback,os
from pathlib import Path
os.environ['PYTORCH_ENABLE_MPS_FALLBACK']='0'
import torch
report={'version':1,'torch':torch.__version__,'os':platform.platform(),'mpsBuilt':torch.backends.mps.is_built(),'mpsAvailable':torch.backends.mps.is_available(),'cpuFallback':False,'passed':False,'tests':[]}
def save(): Path('/Volumes/My Shared Files/harness-output/probe.json').write_text(json.dumps(report,indent=2))
def check(name,fn):
    try: value=fn();report['tests'].append({'name':name,**value})
    except Exception as e: report['tests'].append({'name':name,'passed':False,'error':str(e)})
    save()
def matmul():
    a=torch.arange(16,dtype=torch.float32).reshape(4,4)/16;b=a.T
    error=float(((a@b)-(a.to('mps')@b.to('mps')).cpu()).abs().max())
    return {'maxError':error,'passed':error<1e-5}
def training(optimizer):
    torch.manual_seed(42);cpu=torch.nn.Sequential(torch.nn.Linear(4,8),torch.nn.Tanh(),torch.nn.Linear(8,1));gpu=torch.nn.Sequential(torch.nn.Linear(4,8),torch.nn.Tanh(),torch.nn.Linear(8,1));gpu.load_state_dict(cpu.state_dict());gpu.to('mps')
    torch.manual_seed(19);x=torch.randn(16,4);y=torch.randn(16,1)
    before=float((cpu(x)-gpu(x.to('mps')).cpu()).abs().max());opts=[optimizer(cpu.parameters(),lr=0.01),optimizer(gpu.parameters(),lr=0.01)]
    losses=[];errors=[]
    for step in range(20):
        observed=[]
        for model,opt,device in [(cpu,opts[0],'cpu'),(gpu,opts[1],'mps')]:
            opt.zero_grad();loss=(model(x.to(device))-y.to(device)).square().mean();loss.backward();opt.step();observed.append(float(loss.detach().cpu()))
        losses.append(observed);errors.append(max(float((a-b.cpu()).abs().max().detach()) for a,b in zip(cpu.parameters(),gpu.parameters())))
    torch.mps.synchronize()
    return {'initialForwardError':before,'maxWeightError':max(errors),'firstStepWeightError':errors[0],'losses':losses,'passed':before<1e-4 and max(errors)<0.001}
def conv():
    torch.manual_seed(42);a=torch.nn.Conv2d(1,2,3);b=torch.nn.Conv2d(1,2,3);b.load_state_dict(a.state_dict());b.to('mps');x=torch.ones(1,1,8,8);a(x).square().mean().backward();b(x.to('mps')).square().mean().backward();torch.mps.synchronize();error=float((a.weight.grad-b.weight.grad.cpu()).abs().max());return {'gradientError':error,'passed':error<1e-4}
save()
if report['mpsAvailable']:
    check('matrix multiplication',matmul);check('SGD forward/backward training',lambda:training(torch.optim.SGD));check('Adam forward/backward training',lambda:training(torch.optim.Adam));check('convolution backward',conv)
report['passed']=len(report['tests'])==4 and all(t['passed'] for t in report['tests']);save();print(json.dumps(report),flush=True)

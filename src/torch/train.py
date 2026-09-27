"""Fixed CPU recipes. JSON checkpoints never execute pickle or project code."""
import json, os, random, sys, tempfile, math
from pathlib import Path
import torch

def pack(v):
    if isinstance(v, torch.Tensor):
        return {"tensor": v.tolist(), "dtype": str(v.dtype).removeprefix("torch.")}
    if isinstance(v, dict):
        return {"dict": [[pack(k), pack(x)] for k, x in v.items()]}
    if isinstance(v, tuple): return {"tuple": [pack(x) for x in v]}
    if isinstance(v, list): return [pack(x) for x in v]
    return v

def unpack(v):
    if isinstance(v, dict):
        if set(v) == {"tensor", "dtype"}:
            if v["dtype"] not in ("float32", "int64", "uint8"): raise ValueError("Unsupported tensor dtype")
            return torch.tensor(v["tensor"], dtype=getattr(torch, v["dtype"]))
        if set(v) == {"dict"}: return {unpack(k): unpack(x) for k, x in v["dict"]}
        if set(v) == {"tuple"}: return tuple(unpack(x) for x in v["tuple"])
        raise ValueError("Unknown state encoding")
    if isinstance(v, list): return [unpack(x) for x in v]
    return v

def atomic(file, value):
    content=json.dumps(value, allow_nan=False, separators=(",", ":"))
    if len(content.encode()) > 1024*1024: raise ValueError("Checkpoint exceeds 1 MiB")
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w",dir=file.parent,delete=False) as f:
        f.write(content);f.flush();os.fsync(f.fileno());name=f.name
    os.replace(name,file)
    fd=os.open(file.parent,os.O_RDONLY);os.fsync(fd);os.close(fd)

def train(config, output, identity, resume=None, stop_after=None):
    torch.set_num_threads(1);torch.use_deterministic_algorithms(True)
    spec=config["spec"];random.seed(spec["seed"]);torch.manual_seed(spec["seed"])
    x=torch.tensor([r["x"] for r in config["rows"]],dtype=torch.float32)
    x=(x-torch.tensor(config["means"]))/torch.tensor(config["scales"])
    kind=spec["kind"];model=optimizer=scheduler=None
    if kind=="classifier":
        y=torch.tensor([r["y"] for r in config["rows"]],dtype=torch.long)
        model=torch.nn.Sequential(torch.nn.Linear(x.shape[1],16),torch.nn.ReLU(),torch.nn.Dropout(0.2),torch.nn.Linear(16,8),torch.nn.ReLU(),torch.nn.Linear(8,2))
        optimizer=torch.optim.Adam(model.parameters(),lr=spec["learningRate"])
        scheduler=torch.optim.lr_scheduler.StepLR(optimizer,step_size=20,gamma=0.9)
    centers=x[torch.randperm(len(x))[:spec["clusters"]]].clone() if kind=="kmeans" else None
    completed=epoch=cursor=0;permutation=[];losses=[]
    if resume:
        p=resume["payload"]
        if resume["identity"]!=identity or resume["total"]!=spec["steps"] or p["context"]!=config["context"] or p["runtime"]!=torch.__version__ or p["protocol"]!="torch-cpu@1": raise ValueError("Checkpoint identity/runtime changed")
        completed=p["completed"];epoch=p["epoch"];cursor=p["cursor"];permutation=p["permutation"];losses=p["losses"]
        if resume["completed"]!=completed or len(losses)!=completed: raise ValueError("Invalid progress")
        if model:
            model.load_state_dict(unpack(p["model"]),strict=True);optimizer.load_state_dict(unpack(p["optimizer"]));scheduler.load_state_dict(unpack(p["scheduler"]))
            if sorted(permutation)!=list(range(len(x))) or not 0<=cursor<=len(x): raise ValueError("Invalid sampler")
        else: centers=torch.tensor(p["centers"],dtype=torch.float32)
        torch.set_rng_state(torch.tensor(p["torchRng"],dtype=torch.uint8));random.setstate(unpack({"tuple":p["pythonRng"]}))
    output=Path(output)
    while completed < spec["steps"]:
        if model:
            if cursor>=len(permutation):
                permutation=list(range(len(x)));random.shuffle(permutation);cursor=0;epoch+=1
            indices=permutation[cursor:cursor+spec["batchSize"]];cursor+=len(indices)
            optimizer.zero_grad(set_to_none=True)
            loss=torch.nn.functional.cross_entropy(model(x[indices]),y[indices]);loss.backward();optimizer.step();scheduler.step()
            optimizer.zero_grad(set_to_none=True)  # Checkpoints are optimizer-step boundaries, never partial accumulation.
        else:
            assignment=torch.cdist(x,centers).argmin(1)
            centers=torch.stack([x[assignment==i].mean(0) if (assignment==i).any() else centers[i] for i in range(spec["clusters"])])
            loss=torch.cdist(x,centers).square().min(1).values.mean()
        completed+=1;losses.append(float(loss.detach()))
        payload={"protocol":"torch-cpu@1","context":config["context"],"completed":completed,"runtime":torch.__version__,"model":pack(model.state_dict()) if model else None,"optimizer":pack(optimizer.state_dict()) if optimizer else None,"scheduler":pack(scheduler.state_dict()) if scheduler else None,"torchRng":torch.get_rng_state().tolist(),"pythonRng":pack(random.getstate())["tuple"],"permutation":permutation,"cursor":cursor,"epoch":epoch,"losses":losses,"centers":centers.tolist() if centers is not None else None}
        checkpoint={"version":1,"protocol":"json-step@1","identity":identity,"completed":completed,"total":spec["steps"],"payload":payload}
        if completed % max(1, math.ceil(spec["steps"]/64)) == 0 or completed == spec["steps"] or (stop_after and completed >= stop_after):
            atomic(output/"checkpoint.json",checkpoint)
        if stop_after and completed>=stop_after: return checkpoint
    result={"version":1,"kind":kind,"context":config["context"],"completed":completed,"weights":{k:v.tolist() for k,v in model.state_dict().items()} if model else None,"centers":centers.tolist() if centers is not None else None}
    atomic(output/"model.json",result)
    return checkpoint

if __name__=="__main__":
    config=json.loads(Path("/work/.harness-torch-training.json").read_text())
    resume=os.environ.get("HARNESS_JOB_RESUME")
    train(config,os.environ["HARNESS_JOB_OUTPUT"],os.environ["HARNESS_JOB_IDENTITY"],json.loads(Path(resume).read_text()) if resume else None)
    print("CPU training complete; host evaluation required.")

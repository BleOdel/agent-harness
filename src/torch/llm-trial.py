"""Bounded LoRA experiment; no remote code, downloads, or arbitrary training scripts."""
import copy,hashlib,json,random,tempfile,subprocess,sys,importlib.util
from pathlib import Path
import torch
from transformers import AutoTokenizer,AutoModelForCausalLM
from peft import LoraConfig,get_peft_model,get_peft_model_state_dict,set_peft_model_state_dict

torch.set_num_threads(1);torch.use_deterministic_algorithms(True)
MODEL='/model';STEPS=12;SEED=42
train_texts=[f'A quiet journal. Today I noticed the {x}. I took a slow breath and wrote about my day.' for x in ['rain','sun','trees','clouds','garden','river','moon','stars']]
evaluation=['A quiet journal. Today I noticed the ocean. I took a slow breath and wrote about my day.','A quiet journal. Today I noticed the hills. I took a slow breath and wrote about my day.']
tokenizer=AutoTokenizer.from_pretrained(MODEL,local_files_only=True,trust_remote_code=False)

def make():
    random.seed(SEED);torch.manual_seed(SEED)
    base=AutoModelForCausalLM.from_pretrained(MODEL,local_files_only=True,trust_remote_code=False,use_safetensors=True,dtype=torch.float32,attn_implementation='eager')
    assert base.config.model_type=='llama' and sum(p.numel() for p in base.parameters())<140_000_000
    model=get_peft_model(base,LoraConfig(task_type='CAUSAL_LM',r=2,lora_alpha=4,lora_dropout=0.1,target_modules=['q_proj','v_proj'],layers_to_transform=[28,29]))
    optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=0.002)
    scheduler=torch.optim.lr_scheduler.StepLR(optimizer,4,gamma=0.9)
    return model,optimizer,scheduler

def batch(text):
    b=tokenizer(text,return_tensors='pt',truncation=True,max_length=48);b['labels']=b['input_ids'].clone();return b

def evaluate(model):
    model.eval()
    with torch.no_grad():value=sum(float(model(**batch(t)).loss) for t in evaluation)/len(evaluation)
    model.train();return value

def steps(model,opt,sched,start,end):
    losses=[]
    for i in range(start,end):
        opt.zero_grad(set_to_none=True);loss=model(**batch(train_texts[i%len(train_texts)])).loss;loss.backward();opt.step();sched.step();opt.zero_grad(set_to_none=True);losses.append(float(loss.detach()))
    return losses


module_spec=importlib.util.spec_from_file_location('checkpoint_codec',Path(__file__).with_name('train.py'));codec=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(codec)
data_hash=hashlib.sha256(json.dumps(train_texts).encode()).hexdigest()

def snapshot(model,opt,sched,completed):
    return {'adapter':get_peft_model_state_dict(model),'optimizer':opt.state_dict(),'scheduler':sched.state_dict(),'torchRng':torch.get_rng_state(),'pythonRng':random.getstate(),'completed':completed,'data':data_hash,'baseRevision':'93efa2f097d58c2a74874c7e644dbc9b0cee75a2','runtime':torch.__version__}

if len(sys.argv)>1:
    root=Path(sys.argv[1]);phase=sys.argv[2];model,opt,sched=make();before=evaluate(model)
    if phase=='full':
        initial=steps(model,opt,sched,0,4);codec.atomic(root/'checkpoint.json',codec.pack(snapshot(model,opt,sched,4)))
    else:
        checkpoint=codec.unpack(json.loads((root/'checkpoint.json').read_text()))
        assert checkpoint['runtime']==torch.__version__ and checkpoint['data']==data_hash and checkpoint['baseRevision']=='93efa2f097d58c2a74874c7e644dbc9b0cee75a2' and checkpoint['completed']==4
        set_peft_model_state_dict(model,checkpoint['adapter']);opt.load_state_dict(checkpoint['optimizer']);sched.load_state_dict(checkpoint['scheduler']);torch.set_rng_state(checkpoint['torchRng']);random.setstate(checkpoint['pythonRng'])
    losses=steps(model,opt,sched,4,STEPS);after=evaluate(model)
    codec.atomic(root/(phase+'.json'),{'before':before,'after':after,'losses':losses,'trainable':sum(p.numel() for p in model.parameters() if p.requires_grad),'state':codec.pack(snapshot(model,opt,sched,STEPS))})
else:
    with tempfile.TemporaryDirectory() as tmp:
        for phase in ['full','resume']:subprocess.run([sys.executable,__file__,tmp,phase],check=True)
        full=json.loads((Path(tmp)/'full.json').read_text());resumed=json.loads((Path(tmp)/'resume.json').read_text())
        assert full==resumed, 'Fresh-process checkpoint recovery changed training'
        assert full['after']<full['before']
        print(json.dumps({'version':1,'model':'HuggingFaceTB/SmolLM2-135M','revision':'93efa2f097d58c2a74874c7e644dbc9b0cee75a2','framework':torch.__version__,'device':'cpu','method':'LoRA rank 2 on last two layers q/v','steps':STEPS,'sequenceLimit':48,'batchSize':1,'trainExamples':len(train_texts),'heldOutExamples':len(evaluation),'trainableParameters':full['trainable'],'beforeLoss':full['before'],'afterLoss':full['after'],'freshProcessRecoveryExact':True,'checkpointBytes':(Path(tmp)/'checkpoint.json').stat().st_size,'limitation':'Synthetic smoke trial; not a useful journal model or production quality evaluation.'}))

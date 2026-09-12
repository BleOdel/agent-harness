"""Installed, deterministic full-batch linear regression; training data only."""
import json
import math
import os
import pathlib
import random

root = pathlib.Path('/work')
request = json.loads((root / '.harness-ml-training.json').read_text())
context = request['context']
rows = request['rows']
output = pathlib.Path(os.environ['HARNESS_JOB_OUTPUT'])
features = len(context['features'])
means, scales = context['preprocessing']['means'], context['preprocessing']['scales']
x = [[(value - means[i]) / scales[i] for i, value in enumerate(row['x'])] for row in rows]
y = [row['y'] for row in rows]
rng = random.Random(context['training']['seed'])
model = dict(version=1, kind='linear-regression@1', **context, completed=0,
             weights=[rng.uniform(-0.01, 0.01) for _ in range(features)], bias=request['baseline'])
if os.environ.get('HARNESS_JOB_RESUME'):
    model = json.loads(pathlib.Path(os.environ['HARNESS_JOB_RESUME']).read_text())['payload']
print('Starting from epoch', model['completed'], flush=True)
learning_rate = context['training']['learningRate']
for epoch in range(model['completed'], context['training']['epochs']):
    gradients = [0.0] * features
    bias_gradient = 0.0
    for values, target in zip(x, y):
        error = model['bias'] + sum(w * value for w, value in zip(model['weights'], values)) - target
        bias_gradient += error
        for i in range(features):
            gradients[i] += error * values[i]
    model['bias'] -= learning_rate * bias_gradient / len(rows)
    model['weights'] = [w - learning_rate * gradient / len(rows) for w, gradient in zip(model['weights'], gradients)]
    model['completed'] = epoch + 1
    if not all(math.isfinite(v) and abs(v) <= 1e12 for v in [model['bias'], *model['weights']]):
        raise ValueError('Training diverged; review numeric data and approved learning rate.')
    checkpoint = dict(version=1, protocol='json-step@1', identity=os.environ['HARNESS_JOB_IDENTITY'],
                      completed=epoch + 1, total=context['training']['epochs'], payload=model)
    temporary = output / 'checkpoint.tmp'
    temporary.write_text(json.dumps(checkpoint, allow_nan=False))
    temporary.replace(output / 'checkpoint.json')
(output / 'model.json').write_text(json.dumps(model, allow_nan=False))
print('Training finished. Model quality awaits the protected host evaluation.', flush=True)

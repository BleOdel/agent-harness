"""Fresh standard-library inference only. No project code or holdout labels."""
import json
import math
import pathlib
import sys

request = json.loads(pathlib.Path('/work/input.json').read_text())
model = request['model']
predictions = []
for row in request['features']:
    value = model['bias'] + sum(weight * (x - mean) / scale for weight, x, mean, scale in
                              zip(model['weights'], row, model['preprocessing']['means'], model['preprocessing']['scales']))
    if not math.isfinite(value):
        raise ValueError('Nonfinite prediction')
    predictions.append(value)
print(json.dumps({'version': 1, 'predictions': predictions}, allow_nan=False))

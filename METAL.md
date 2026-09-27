# Metal GPU training and checkpoint recovery

This lane trains a small numeric prediction model on the Apple GPU in the
existing offline macOS VM. It uses a fixed Swift/Metal recipe with float32
full-batch gradient descent, no framework downloads, and no CPU training fallback.
It does not change ordinary `harness work`, use model-provider tokens, or train
an LLM. VM startup/compilation can dominate small workloads; no speedup is claimed.

## Guided use

Start with `harness guide` → **Metal GPU training**. Check readiness, validate the
runtime if requested, then approve training using short prompts. Saved workflows
appear by name with their status and last completed epoch. The guide offers the
appropriate train, recover, evaluate or export action.

Data is an external CSV: `id`, 1–16 numeric predictors and a target column;
20–2000 independent rows, no missing values or duplicate predictor vectors.
Keep it outside project source and harness state. Values must be finite and
within ±1,000,000. Categorical, image, text and time-series tasks are not supported.
The [synthetic CSV](examples/metal/data.csv) and [settings](examples/metal/spec.json)
exercise the relationship `y = 3 + 2*x` without using personal information.

The harness freezes data and a deterministic 80/20 split at approval. Means and
scales come only from the training rows. The guest receives those rows, settings,
and the last verified checkpoint. It receives neither project source, holdout
rows nor the quality thresholds. Data and checkpoints are saved in plaintext
under `<project>-harness/metal`; they are not encrypted by the harness.

## Explicit commands

```sh
harness metal doctor
harness metal validate
harness metal setup
harness metal list
harness metal train <id>
harness metal inspect <id>
harness metal evaluate <id>
harness metal export <id> /external/new-model.json
harness metal release <id> --yes
```

For scripts: `harness metal approve <spec.json> <external.csv>` records exactly
the selected data, runtime, quality thresholds and budget. `harness metal train
<id> --one-checkpoint` pauses after one completed segment. `harness metal resume
<id>` continues the saved workflow; it never silently starts over.

## What recovery guarantees

A segment runs in a fresh, offline VM with the existing native guardian and
resource ownership checks. The default segment has 100 epochs and a 300-second
limit including VM boot/compilation. Maximums: 1000 epochs, eight attempts,
600 seconds per segment and 4800 reserved seconds in total. Reservations are
recorded before dispatch and are not refunded on failure.

Each completed segment produces a checkpoint containing weights, bias, completed
epoch, device name and successful dispatch count. This optimizer has no momentum
or random sampling state. The host verifies exact progress, finite values,
feature order, preprocessing, settings, approval identity and device continuity
before atomically replacing the saved state. The approval binds dataset hashes,
native image/tool identity, host kernel/architecture and the training protocol.
Changed data, runtime, settings or corrupt checkpoints stop resumption.

Ctrl-C or a timeout preserves the last *completed* segment. Work since that
checkpoint is repeated. After a controller crash, choose **Recover** in the guide
(or `harness metal recover <id>`). Recovery refuses live or foreign owners, cleans
only the owned native job and can retain a fully completed child result that the
outer controller had not yet saved. Otherwise it returns to the prior checkpoint.
Retiring a workflow disables training/export and releases its model artifact reference;
approved data and checkpoint audit stay saved. An exhausted budget requires a new explicit approval; it is not reset by resume.
A new approval is a new experiment, not a continuation of the old checkpoint.

## Quality and evidence

Training completion is not a quality pass. Host evaluation uses the retained
holdout and the fixed model interpreter, comparing RMSE with both the approved
ceiling and the training-mean baseline. The first evaluated model is frozen,
including after failure. Repeating evaluation cannot tune it on the holdout.
Only a passing model exports through `metal export`, as inert JSON with
`evaluation-passed` artifact provenance. Nothing is published or deployed.

`harness metal validate` (also `npm run verify:metal`) runs real GPU training,
saves a checkpoint, kills a controller during its next VM segment, recovers and
resumes in a new VM. It compares resumed and uninterrupted weights within 0.00001,
checks held-out accuracy, rejects corrupted/wrong-approval checkpoints and a bad
quality result, and verifies the native slot is cleared. A protocol/runtime change
requires new validation. This is a synthetic correctness trial, not a performance,
robustness, privacy or production-quality certification.

## Boundaries

The VM has 2 CPUs and 4 GiB RAM and uses the Apple paravirtual Metal device.
The existing native isolation, network dropper, wall-clock guardian, disk-space
watchdog and owned cleanup apply; see [NATIVE.md](NATIVE.md). GPU capacity is shared
with the host, with no exclusive allocation or hard VRAM quota. No CUDA, arbitrary
PyTorch/MLX workloads, distributed training, mobile GPU, Windows GPU, serving or
model registry support is implied. Ordinary implementation acceptance is separate.

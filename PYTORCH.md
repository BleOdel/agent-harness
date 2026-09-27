# PyTorch CPU learning and recovery

The PyTorch lane runs fixed recipes in an offline Linux arm64 Docker container,
with 2 CPUs, 2 GiB RAM and the existing bounded job runner. No provider tokens are
used for training. It supports:

- **Supervised deep learning:** a binary classifier with two hidden layers,
  ReLU, dropout, Adam and a learning-rate scheduler. Inputs are numeric columns.
- **Unsupervised learning:** k-means on numeric columns without target labels.
  Held-out distance measures compactness, not useful or meaningful group names.
- **A small language-model experiment:** a pinned SmolLM2-135M LoRA trial. This
  is a fixed synthetic experiment, not general fine-tuning of user corpora.

## Start through the guide

Create a Python project with `harness init --python`, then choose **PyTorch CPU
deep learning and clustering** in `harness guide`. Prepare the runtime once,
check it, and set up a model. Model settings and data approval remain separate
from the coding agent's provider/model settings.

`harness torch provision` downloads checksum-pinned binary wheels (about 202 MiB),
builds an image offline and records its immutable ID separately in
`~/.config/harness/torch/runtime.json`. It expects the existing `harness-python:e2`
base. To prepare that base, from the harness installation:

```sh
docker build -f containers/python.Dockerfile -t harness-python:e2 .
harness torch provision
harness torch doctor
```

This initial manifest supports **Linux arm64, Python 3.13.12 and PyTorch
2.14.0+cpu**. It installs no PyTorch package into your host Python environment.
Downloaded wheels are retained under `~/.config/harness/torch/cpu`; the Docker
image contains the installed libraries. CPU workflows do not need the Mac VM.

## Data and quality goals

`harness torch setup` asks for an external JSON file, recipe, step count and
quality goal. Example files and specs are in `examples/torch`. Keep the dataset
outside project source; copy an example to a separate data folder first.

```json
{"features":["size","weight"],"rows":[
  {"id":"sample_1","x":[1.2,3.4],"y":0},
  {"id":"sample_2","x":[4.5,6.7],"y":1}
]}
```

Use 20–2000 independent, unique rows and 1–16 numeric features. Classifier labels
are exactly 0 or 1. Omit `y` entirely for clustering. Approval freezes a
deterministic 80/20 training/holdout split, feature order and normalization fitted
only on training rows. Both classifier splits must contain both classes.
Known dataset copies in source are refused; this cannot detect arbitrary encoded
or semantic leakage. Choose representative data and independent examples.

The classifier must beat the training-majority baseline and your maximum error
fraction. Clustering must beat one centroid at the normalized training mean and
your mean squared distance ceiling. Fresh offline PyTorch inference receives only holdout predictors and must agree
with host inference from inert numeric model arrays. Labels remain on the host. It is a
single-candidate quality gate, not a hyperparameter search facility. A new
approval with the same data does **not** create an independent scientific test.

## Run and recover

```sh
harness torch list
harness torch train <approval-id>
harness torch inspect <approval-id>
harness torch cancel <approval-id>
harness torch resume <approval-id>
harness torch evaluate <approval-id>
harness torch export <approval-id> /absolute/new-model.json
```

Training saves at most 64 scheduled atomic JSON checkpoints, without pickle,
including the final update. Every checkpoint describes a fully completed update. Classifier
state includes model parameters/buffers, Adam moments and counters, scheduler,
PyTorch and Python RNG states, shuffled row order, cursor, epoch, loss history and
completed steps. Checkpoints occur after complete updates with gradients cleared;
there are no unfinished accumulation, worker-prefetch or mixed-precision states.
K-means retains its centroids, random states, progress and loss history.

The host retains validated checkpoints while the job runs. A killed controller
may lose steps after its last retained checkpoint; it replays those steps, rather
than claiming every in-flight update was saved. After a hard crash, follow the
existing writer-lock recovery instruction, then:

```sh
harness torch recover <approval-id>
harness torch resume <approval-id>
```

Recovery requires unchanged data, recipe, model settings, project source, image,
prepared dependency identity and approved resource limits. A timeout spends one
attempt reservation. Defaults allow four 300-second attempts. No checkpoint
means no automatic retry from scratch. Explicitly retire a finished workflow
with `harness torch release <approval-id> --yes`; audit data remain saved and
unused artifact bytes can then be cleaned through `harness artifacts cleanup`.

## Small language-model trial

```sh
harness torch trial-llm
```

This downloads only the pinned public SmolLM2-135M safetensors/tokenizer files,
verifies hashes, then runs offline. Remote model code is disabled. The base is
frozen; rank-2 LoRA trains 7,680 parameters on the last two layers' query/value
projections. Budget: 12 updates, batch 1, at most 48 tokens, five minutes, 2 GiB.
Eight synthetic examples train the adapter; two distinct examples measure loss.
A JSON checkpoint after step four is restored in a fresh Python process and the
final adapter, optimizer, scheduler, random states and loss trajectory must match.

Measured on the development Mac's CPU runner: held-out loss **4.432632 →
4.296396**, with exact fresh-process recovery and a 544,281-byte checkpoint.
This is feasibility evidence, **not** a useful journal model, broad language
quality evidence, a user-data workflow or large-model training support. The trial
retains a report under `<project>-harness/torch-trials`; its temporary adapter is
not published or promoted as an evaluated production model. Model files stay in
`~/.config/harness/torch/model` (or a supplied, hash-verified directory).

## PyTorch GPU compatibility in the Mac VM

```sh
harness torch probe-mac
```

A separate pinned macOS tool bundle is installed **inside a disposable offline
VM clone**. The current native base is unchanged. The VM has 2 CPUs and 4 GiB
RAM; GPU memory is shared with the host and has no hard per-job VRAM quota.
CPU fallback is disabled. A five-minute external guardian bounds the probe.
Use `harness torch recover-mac-probe` only after a crashed probe owner has ended.

**Current result: not qualified.** PyTorch 2.14.0 sees MPS on the Apple
Paravirtual device in macOS 26.6.2. Basic matrix multiplication and convolution
backward passed, but an identical neural network's initial output differed from
CPU by **0.249866**, and SGD/Adam training exceeded numerical tolerances. Merely
reporting `mps.is_available()` would have missed this. No PyTorch GPU training
workflow is enabled based on these results. The existing fixed Swift/Metal
regression lane is separate and retains its own validation.

Reports: `~/Library/Application Support/Harness/native/torch-mps-probe.json`
and `torch-mps-probe.log`. The result applies to the tested framework/virtual GPU,
not every PyTorch version or the physical Mac GPU. CUDA still requires a separate
NVIDIA environment. General GPU, distributed training, arbitrary architectures,
large-model pretraining and production LLM evaluation are outside this milestone.

## Verification

- `harness torch validate`: real offline CPU runs, fresh-process exact checkpoint
  comparisons for both recipes, and an optimizer-reset mutation that must differ.
- `npm run verify:torch`: real job isolation, data identity, cancellation/resume,
  forced controller death/recovery, host quality checks, export and retirement.
- `npm test` and `npm run build`: regression suite and TypeScript validation.

Skipped Docker checks are not runtime evidence. Revalidate after changing the
recipe or runtime. Exact equality is established for this pinned CPU setup;
other devices/framework versions require their own evidence.

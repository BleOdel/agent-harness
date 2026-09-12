# CPU model training and evaluation

E4 supports one installed numeric linear-regression recipe on the existing
Python/Linux Docker runner. It trains a model, saves compatible checkpoints,
evaluates a protected holdout, and exports inert JSON weights. This is useful for
learning the workflow and small independent-row regression problems. It is not
a general framework for training arbitrary ML models.

## Start with the guide

Use the [Python setup](PYTHON.md) and its pinned Python image. The harness controller
still needs Node 26. In an empty project run `harness init --python`, then
`harness guide`. Select **Build and evaluate a CPU ML model**.

1. Select **Set up a numeric regression workflow**. Choose a CSV outside the
   project, its target column, and a readable workflow title.
2. Enter an acceptable RMSE in target units and the required percentage improvement
   over the training-mean baseline. These should reflect the problem's needs.
   Optional prompts adjust epochs, learning rate, seed and time limits.
3. Review and approve the concrete data, split, training and evaluation settings.
   Approval saves the data; the original CSV need not be selected again.
4. Select the saved workflow by title and **Train and evaluate the approved model**.
   Progress shows saved epochs and remaining attempts. Success reports measured
   RMSE, baseline RMSE and relative improvement.
5. Inspect the result, then export to a new local file outside the project/state.
   Export refuses to overwrite an existing file. No IDs, JSON edits or repeated
   specification entry are required in this journey.

`harness verify` tests and packages source code. `harness ml train` assesses the
saved model against approved data and thresholds. Neither substitutes for the
other, and neither commits source or publishes a model. Raw job outputs remain
unverified; a passing evaluation creates a separate `evaluation-passed` artifact
manifest bound to the approval and report hashes.

## Supported data and recipe

CSV v1 requires a header with `id`, 1–16 numeric predictor columns and the selected
numeric target. Names use letters, numbers or underscores (1–64 characters).
Each row has a unique ID of 1–64 letters, digits, underscores or hyphens. Use
20–10000 independent rows, at most 2 MiB of CSV, finite values within ±1000000,
and no missing cells. Quoted CSV fields are supported; locale-formatted numbers,
duplicate predictor vectors and predictors identical to the target are refused.

The host sorts rows by SHA256 of `seed:id`; the first floor(20%) form the holdout.
The remaining rows supply predictor means/population standard deviations and the
constant mean-target baseline. Near-constant predictors use scale 1. The schema,
raw CSV hash, ordered split IDs, split hashes, preprocessing and recipe hashes
are frozen before training. The original path is not saved in the approval.

Training uses Python's standard library, deterministic seeded initialization and
full-batch gradient descent on standardized inputs. Defaults are seed 42,
200 epochs and learning rate 0.05. Allowed epochs are 1–1000; learning rate must
be positive and at most 0.1. Divergent/nonfinite weights fail. JSON stores feature
order, preprocessing, approved settings, completed epochs, weights and bias.
No pickle, executable model payload, external ML dependency or arbitrary trainer
is loaded. The reference runtime and locked project dependencies are recorded
through the training job's existing execution identity.

## Protected evaluation

Only training rows enter the job, after fresh dependency installation. The fixed
trainer runs with Python `-I -S`, which excludes project imports and dependency
startup hooks. Approval files and holdout rows never enter training mounts.

Evaluation loads the numeric JSON model in a fresh offline Python container with
only model data and holdout predictors. Project code, installed project dependencies,
provider credentials and holdout labels are absent. The host checks each prediction
against its own implementation, then computes RMSE from host-held labels. It ignores
training-reported quality scores. Success requires both the approved absolute
RMSE ceiling and relative improvement over the training-mean baseline.

Prediction comparison tolerance is `1e-9 * max(1, abs(expectedPrediction))`.
The RMSE ceiling tolerance is `1e-9 * max(1, approvedMaxRmse)`; baseline comparison
uses `1e-9 * max(1, baselineRmse)`. Baseline RMSE must exceed its tolerance so a
constant/degenerate holdout cannot claim improvement. Exact values and tolerances
are saved in the report; byte-identical numerical results across platforms are
not promised.

The first evaluation consumes one model hash for that approval. A different model
cannot be scored under it, including after failure. Infrastructure failures allow
retrying the same model through the guide; an actual quality failure remains saved.
Do not repeatedly approve the same data to tune against the holdout. The operator
can deliberately misuse approvals; this is not an anti-cheating boundary against
the host owner. Data selection bias, target-derived features, grouped or temporal
leakage and encoded data copies require domain review. Known raw dataset copies
and recognized CSV/JSON holdout rows in project source are refused, but that scan
cannot establish absence of all leakage.

These choices follow the principles of [splitting before fitting preprocessing](https://scikit-learn.org/stable/common_pitfalls.html)
and [avoiding executable pickle model payloads](https://scikit-learn.org/stable/model_persistence.html).
The harness's installed recipe does not depend on scikit-learn.

## Resume, recovery and retention

Training uses [E3 jobs and limits](JOBS.md): 2 CPUs, 2 GiB RAM, 512 MiB writable
workspace, offline execution, finite attempt/time reservations and at most
100 retained checkpoint events. Cancellation retains the last validated epoch.
Continue from the saved workflow; the next attempt installs a fresh environment
and loads only a checkpoint with matching data, source, environment, recipe,
feature order, preprocessing, parameters and epoch. A changed identity is refused.
An early stop does not refund its execution reservation. No checkpoint means no
automatic restart; create a new approval with an explicit budget if needed.

After a controller crash, use the guide to recover the ended writer, select the
ML workflow, recover its owned training resources, then continue. A live writer
cannot be stolen. The generic E3 watchdog and ownership checks remain in force.
An interrupted evaluation can rerun the same model; it never trains another one.

Retiring a workflow releases its training/model artifact references and disables
resume/export through the workflow. `harness artifacts cleanup` then reclaims
unreferenced blobs. Approved train/holdout data and evaluation/audit records remain
in `<project>-harness/ml/<id>/` until the project and sibling state are deliberately
removed. These host-only JSON files use mode 0600; storage is not encrypted and
there is no automatic dataset expiration or aggregate dataset quota. Each JSON
state file is limited to 2 MiB. Do not treat synthetic-demo defaults as a data
retention policy for sensitive datasets.

## Explicit commands and exact example

```bash
harness ml setup
harness ml approve /external/data.csv --spec /external/spec.json
harness ml list --json
harness ml inspect <id> --json
harness ml train <id>       # also evaluates when training succeeds
harness ml cancel <id>
harness ml recover <id>     # after ended-writer recovery
harness ml resume <id>
harness ml evaluate <id>    # same saved model only
harness ml export <id> /external/new-model.json
harness ml release <id> --yes
```

From the harness checkout with `HARNESS_CONFIG` set and `HARNESS_IMAGE_ID` selecting
the pinned Python image, run the shipped [synthetic example](examples/ml/run.ts):

```bash
node examples/ml/run.ts /tmp/harness-ml-example-new
```

It refuses an existing destination, creates a Python project, approves the exact
shipped [CSV](examples/ml/data.csv) and [specification](examples/ml/spec.json), trains,
evaluates and exports `model.json`. The CSV remains outside the created project.
The synthetic relationship is `target = 3 + 2*x`; the approved RMSE ceiling is
0.01 with at least 90% improvement over the mean baseline. This demonstrates the
pipeline, not predictive value on a real-world problem.

```bash
HARNESS_PYTHON_IMAGE_ID=sha256:<your-pinned-Python-image> npm run verify:ml
```

The configured suite refuses skipped checks and covers real Docker training,
interruption/resume, actual training mounts, changed data/holdout, known leakage,
forged predictions, degraded models, preprocessing mismatch, export and a full
keyboard-only terminal journey. Deterministic fixtures make zero provider calls.
Human completion rate, confusion and time to first useful result are unmeasured;
the U0 human walkthrough remains follow-up.

Classification, categorical/missing/text/image data, grouped/time-series splits,
automatic feature or hyperparameter search, arbitrary frameworks, GPU training,
model serving, signing and registry publication are outside E4. Passing one small
holdout does not establish fairness, robustness, generalization or production
suitability. [E5](NEXT.md#e5--isolated-platform-runners) next requires a concrete
infrastructure decision before native runners are implemented or provisioned.

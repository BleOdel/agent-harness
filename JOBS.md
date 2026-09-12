# Artifacts and saved jobs

E3 supports local output retention and finite, resumable command jobs on the
existing Node and Python Linux Docker runners. An ordinary job runs code already in your
project; the [E4 ML workflow](ML.md) also supplies an installed regression recipe. It makes no model call, applies no source changes and publishes nothing.

## Guided use

Run `harness guide`, select the project, then **Manage jobs and retained outputs**.
Choose **Create a saved job**. Short prompts collect the command, output names,
optional checkpoint step count and time/attempt budget. Review and save once.
Select the saved job by title to run it, inspect progress or continue from a
checkpoint. Outputs and their verification status are selectable by name.
Export asks for a new file outside project source and harness state; it refuses
to overwrite an existing file. No IDs or JSON editing are required in the guide.

The main guide also offers **Test, package and retain build outputs**. This runs
fresh adapter checks and retains declared output from a passing build check.
Python retains its wheel; Node retains files under `dist` and `build` when a build
script is declared. Ordinary `work` and team execution still discard generated
outputs: use `verify --retain` against the applied source to retain a fresh build.

## Explicit commands

```bash
harness verify --retain
harness job setup
harness job create /absolute/path/job.json
harness job list --json
harness job run <job-id>
harness job inspect <job-id> --json
harness job cancel <job-id>        # from another terminal; or Ctrl-C in the job
harness job recover <job-id>       # after recovering an ended controller's writer
harness job resume <job-id>
harness artifacts list --json
harness artifacts inspect <artifact-id>
harness artifacts export <artifact-id> /separate/output/result.bin
harness job release <job-id> --yes # retire the job; it can no longer resume
harness artifacts release <verify-producer-id> --yes
harness artifacts cleanup         # collect only unreferenced blobs
```

Creation saves settings; `run` executes them. Failed/cancelled/timed-out runs exit
nonzero. Scripts never receive interactive prompts unless they invoke `setup` or
`guide` (which require a terminal). `look` includes job status and retained-output
counts. The existing web view remains focused on source work and teams; jobs use
the guide and the explicit inspection commands.

## Outputs, provenance and limits

Write declared job outputs relative to the `HARNESS_JOB_OUTPUT` directory
(`/work/.harness-output`). Output names in the declaration are relative to that
directory. Files are opaque bytes: wheels, archives and model files are never
unpacked or executed on the host during retention or export. Undeclared files are
discarded with the workspace, except the fixed diagnostic log and checkpoint.

The store is beside the project at `<project>-harness/artifacts`. A manifest
records SHA256, byte count, producer ID, source-input digest, execution identity,
creation time and verification status. Job state retains the adapter, runner,
capability report, immutable image, dependency key, declaration and source snapshot.
Verification producers retain equivalent details in `<producer-id>.json` beside
the artifact store. Hash checks detect changed blobs; they do not establish that
an output is correct or safe to execute.

- Job results and checkpoints are **unverified**. Exit zero and reported progress
  are diagnostics from project code, not independent proof of application or model
  quality.
- `verify --retain` results are **diagnostics-passed**. Approved application
  acceptance remains a separate requirement; this command never applies source.
- E4 creates **evaluation-passed** model manifests only after host comparison
  against approved data and thresholds. They bind approval and report hashes;
  the original training output remains unverified.
- No artifact is signed, uploaded, installed on the host or automatically published.

Limits in this first release:

| Resource | Limit and enforcement |
|---|---|
| Concurrent jobs | One foreground controller per project, using the project writer |
| CPU / RAM | Existing Docker limit: 2 CPUs / 2 GiB; RAM includes tmpfs usage |
| Writable job workspace | 512 MiB tmpfs; prepared source is mounted read-only |
| Other scratch / processes | 256 MiB `/tmp`; 256 PIDs; read-only container root |
| Execution time | Declared seconds per attempt; at most 24h of total reservations |
| Attempts | Declared 1–8; each dispatch reserves its entire time allowance |
| Retained file / batch | 32 MiB per file; 64 MiB of declared job or build outputs |
| Logs / checkpoints | 1 MiB log; 1 MiB checkpoint; at most 100 checkpoint events/job |
| Store | 512 MiB unique blobs and 256 manifests per project |

Preparation uses existing bounded adapter steps and their gate timeouts. A cancel
request during preparation is honoured after the current preparation step, before
job launch. Execution reservations are conservative: an early stop or crash does
not refund the reservation. Measured execution seconds are reported separately.
Local Docker exposes no billing telemetry: `reportedUsd` is null and `unknown`
is true. Time budgets are not dollar budgets or guarantees about external bills.

The host enforces job timeouts and an in-container supervisor also stops the
command on its deadline. The supervisor stays alive for output transfer, up to
60 seconds after the command ends, then exits. On normal completion/cancellation
the host removes it sooner. A killed controller may lose output newer than its last
committed checkpoint. Recovery removes owned resources before allowing resume.
Network is disabled and model credentials, Pi, skills, Docker socket and artifact
store are not mounted. Fresh offline dependencies are prepared before each attempt.
Input preparation and installed dependencies must fit the job workspace.

## Checkpoint protocol: json-step@1

Programs opt in; the harness cannot resume arbitrary programs automatically.
Declare a positive total step count and atomically replace
`$HARNESS_JOB_OUTPUT/checkpoint.json` with:

```json
{
  "version": 1,
  "protocol": "json-step@1",
  "identity": "value from HARNESS_JOB_IDENTITY",
  "completed": 3,
  "total": 10,
  "payload": { "your": "JSON state" }
}
```

Read `HARNESS_JOB_RESUME` when nonempty: it names the restored checkpoint file.
`HARNESS_JOB_TOTAL` contains the declared total. Write a temporary file and rename
it over the checkpoint so the controller observes a complete document. The
installed protocol validates version, identity, integer progress bounds, total,
nondecreasing completed steps and object payload. A newly reported step retains a
new immutable artifact. Generic payloads remain algorithmically unverified. E4 ML jobs additionally bind
feature order, preprocessing, training settings and model epoch to their approval.
Model quality still requires the separate protected evaluation described in ML.md.

Identity binds the job declaration, frozen source, dependency environment, adapter,
runner capabilities, immutable image and installation policy. Resume compares live
source and accepted settings, verifies the stored blob, revalidates the checkpoint,
and prepares a fresh environment. It refuses altered inputs/settings, corrupt
bytes and incompatible formats. It does not silently restart a job when no valid
checkpoint exists; create a new job to start over. Changing requirements also
invalidates the live-source baseline.

## Recovery and retention

After a controller crash, return to `harness guide`. Recover the ended writer,
then select the saved job and recover its resources. Live writers cannot be stolen.
Recovery checks saved container name, image and ownership labels before removal;
it does not kill arbitrary processes or unrelated containers. It uses saved runner
settings even when the current project configuration has changed.

All manifest references protect blobs from cleanup, including checkpoints from
active or resumable jobs. To reclaim those outputs, deliberately retire the job
first. ML job/model references require `harness ml release`, which retires the
whole workflow and preserves approval/data/evaluation audit files. Release is irreversible at the harness level and disables resume. Store
limits refuse further retention with a cleanup remedy; they never evict an active
job's checkpoint automatically. Interrupted atomic blob/manifest writes do not
invalidate committed entries and can be collected. Existing source recovery and
acceptance records have their separate retention policies.

New source candidates refuse files over 2 MiB and known installer, wheel, model
and dataset formats (`whl`, `apk`, `aab`, `dmg`, `msi`, `safetensors`, `ckpt`, `onnx`,
`pt`, `h5`, `hdf5`, `parquet`, `arrow`). Small regular binary source assets remain
supported. Put generated data in declared outputs, rather than raising a source
change limit. Historical undo still preserves the original bytes.

## Reproducible example and verification

Copy [counter.mjs](examples/jobs/counter.mjs) into an initialized Node project.
In job setup enter `node counter.mjs`, output `result.json`, four checkpoint steps,
20 seconds per attempt and three attempts. Interrupt after a saved checkpoint,
select Resume in the guide, then inspect/export the result. The equivalent
[declaration](examples/jobs/job.json) supports `harness job create` in scripts.

```bash
HARNESS_PYTHON_IMAGE_ID=sha256:<your-pinned-Python-image> npm run verify:jobs
```

The configured suite runs real Docker Node/Python jobs, controller SIGKILL and
watchdog recovery, cancellation, incompatible/corrupt checkpoints, resource limits,
source-output separation, Python wheel retention and a complete keyboard-only
create/run/inspect/export journey. All fixtures are deterministic and make zero
model-provider calls. Automated PTY success does not establish human usability;
the human U0 trial remains unmeasured follow-up. GPU/native runners, a background
scheduler, arbitrary checkpoint formats and external publication are not supported.

E6 adds a separate [Linux desktop diagnostic workflow](DESKTOP.md), with ASAR packages, runtime descriptors and GUI screenshots in the same artifact store. Retire those references with `harness desktop release` or the desktop guide before generic cleanup. Desktop UI sessions rerun fresh; they are not E3 checkpoint jobs.

[E9a release preparation](RELEASES.md) retains its own immutable artifact reference. Retiring the original job does not invalidate an approved release. Retire the release separately before its snapshot can be collected; local staged outputs and audit remain.

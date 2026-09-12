# Python projects

`python-pip@1` supports a single pure-Python library or CLI package on Linux Docker. The reference image supplies Python 3.13.12, pip 25.3 and Node 26.5.0; Node runs the harness's model launcher. Your host Python environment is never used for project verification.

## Start through the guide

Build the reference image once from the harness repository, then select its immutable ID for this shell:

```bash
docker build -f containers/python.Dockerfile -t harness-python:e2 containers
export HARNESS_IMAGE_ID="$(docker image inspect harness-python:e2 --format '{{.Id}}')"
mkdir -p ~/Developer/file-analysis
cd ~/Developer/file-analysis
harness guide
```

Choose **Create a Python project here**, then describe your project. For example: “A CLI that reads a UTF-8 file and reports its line, word and character counts. Show a clear error for missing or invalid files.” Planning skills, including an available `grill-me`, ask questions and retain the answers. Review the saved scope, generate and accept its items, approve expected application behaviour, and build. You do not need to retype the specification or edit JSON for this journey.

The Dockerfile pins Linux/arm64 base images used for this release's verification. An x64 runner needs matching immutable x64 base images and its own verification; the supplied image is not a claim of native macOS, Windows or cross-platform execution. Building the image does not change your global harness configuration. To keep a Node shell using its existing runner, leave that shell's `HARNESS_IMAGE_ID` unchanged.

Explicit commands remain available:

```bash
harness init --python     # in a new empty project
harness project setup    # choose environment and planning/build skills
harness doctor           # checks the selected image and prerequisites
harness verify           # fresh offline tests and wheel builds; no model calls
harness plan             # saved interview, then review/approve/import through guide
harness checks setup     # approve expected CLI outputs or file contents
harness work             # one accepted item; applies on success
harness look
harness undo r1
```

`harness verify` uses the existing runner/Pi path configuration but mounts no credentials, Pi package or skills into verification containers. It reports project diagnostics and reproducible packaging; it does not approve, apply, commit, export or publish anything. An empty scaffold checks only that package installation works. Meaningful application tests and separately approved behaviour are still needed.

## Project format

Initialization writes the requirements and tooling pins automatically:

```text
.python-version          exact target Python version, initially 3.13.12
pyproject.toml           static package metadata and console script declarations
requirements.lock        exact versions and SHA-256 wheel hashes, including tooling
src/<package>/           one importable package with __init__.py
  cli.py                 console entry point
tests/                  recursive test_*.py and *_test.py collection
AGENTS.md                Python-specific builder instructions
```

The package name must be a lowercase Python identifier and must not shadow pip or a locked dependency. Metadata uses `[project]` with static `name`, three-part `version`, `description`, exact `requires-python`, optional `dependencies` and optional `[project.scripts]`. `requires-python` must equal `==` followed by `.python-version`. Console targets must be functions in this package. The build system is exactly:

```toml
[build-system]
requires = ["flit_core==3.12.0"]
build-backend = "flit_core.buildapi"
```

This release restricts Flit's wider configuration surface: no dynamic metadata, custom backends, backend paths, hooks, optional dependency groups, alternate package roots or native extensions. Package data supports `.txt`, `.json`, `.csv`, `.md` and `.toml`, alongside `.py` and `.pyi`. Flit's standard metadata and console script mechanism underlie the restricted format. See [Flit configuration](https://flit.pypa.io/en/stable/pyproject_toml.html).

The only dependency input format is `requirements.lock`. Each non-comment entry is `name==version --hash=sha256:<64 lowercase hex characters>`, with multiple wheel hashes allowed and backslash line continuations supported. Include transitive dependencies. Keep the scaffold's pytest, flit_core, packaging, pluggy and iniconfig versions and hashes unchanged. Application dependencies in `pyproject.toml` must use the same exact versions. Dependency changes require a dedicated `shared-inputs` assignment before dependent implementation.

The preparer sends only `pyproject.toml`, `.python-version` and `requirements.lock` to a credential-free container. It validates metadata without importing project code, then downloads the explicitly listed packages from PyPI with `--require-hashes --only-binary=:all: --no-deps`. Dependency metadata cannot redirect downloads. Offline installation also uses `--no-deps`, followed by `pip check` to require a complete compatible dependency closure. No project source, credentials or model resources enter the networked preparer. URLs, Git/local dependencies, editable installs, environment markers, extras, requirement includes, alternate indexes and source distributions are refused. These flags implement pip's documented [hash-checking and wheel-only policy](https://pip.pypa.io/en/stable/topics/secure-installs/).

Every worker and executable check gets a fresh virtual environment, an offline hash-checked install from the downloaded wheels, an offline project-wheel build, installation of that wheel and a dependency consistency check. Installed source must not change project files. Environment identity binds adapter policy, all dependency inputs, image and runtime; each cache file is checked before reuse. Changing the lock or corrupting a wheel cannot reuse the old environment. Third-party wheels may still contain executable Python, including `.pth` startup code; hashes establish identity, not trustworthiness. All such execution stays inside the normal container boundary.

## What verification means

The harness invokes pytest with read-only configuration and reporting code. Test selection is fixed, third-party plugin autoload is disabled, and every conventional test file must appear in collection. Root/subdirectory tests outside `tests/` are rejected. Existing `pytest.ini` and environment addopts cannot silently change the invocation. Custom `HARNESS_TEST_COMMAND` values are refused for this adapter; leave it unset for automatic selection.

Reports distinguish zero collected tests, all-skipped suites, failures, missing/duplicate/malformed reports, incomplete results and uncollected files. Python never uses the Node assertion counter. Normal final tests import the installed wheel; development can use `PYTHONPATH=src .venv/bin/python -m pytest` to check current edits before the harness rebuilds them. Candidate tests are arbitrary Python and can alter imports or fabricate reports, so reports remain diagnostics, not independent proof.

Before application, separate fresh containers execute the operator-approved commands. The host compares exit status and expected output/file content with expectations that were never exposed to the builder. Approval, source and environment identities must match. Tests explicitly demonstrate that a convincing counterfeit pytest report cannot substitute for these checks. The quality of the approved cases still limits what is verified.

The build gate compares two wheels byte for byte with a fixed `SOURCE_DATE_EPOCH`. Installed package imports and console entry points are exercised by tests/acceptance. Wheels, `.venv`, bytecode and caches are never applied as source. `harness verify --retain` keeps a fresh checked wheel in the artifact store; the guide can inspect and export it. Python jobs also retain declared outputs and compatible JSON checkpoints. See [Jobs and outputs](JOBS.md). Python supports ordinary work and team stage/resume/apply/undo; optional team `checks` contract suites are explicitly refused for now. Use approved acceptance cases for independent Python application checks.

## Verify the adapter

From the harness repository, with the usual Node runner configuration:

```bash
export HARNESS_PYTHON_IMAGE_ID="$(docker image inspect harness-python:e2 --format '{{.Id}}')"
npm run verify:python
```

This separate image variable selects the Python integration fixtures; project commands continue to use `HARNESS_IMAGE_ID`. The suite refuses missing prerequisites and skipped tests. It covers offline installation, source-only dependency refusal, changed locks, cache corruption, runtime mismatch, fixed collection, fake reports, timeout cleanup, repeated wheels, plan handoff, ordinary work, team application/resume and byte-preserving undo. A real PTY exercises the guided Python journey with a deterministic interview/builder fixture and a read-only `grill-me` resource. These automated fixtures make no model-provider calls and do not establish human usability or actual skill compliance. A human walkthrough remains part of U0 follow-up.

For the file-analysis demo, approving `python -I -m file_analysis.cli sample.txt` with the exact expected JSON checks the installed package. A second invocation through `file_analysis` checks the console entry point. Missing-file checks should expect a nonzero exit and confirm any existing input/output files remain unchanged. Ordinary/team build wheels remain disposable; `harness verify --retain` keeps a fresh build against applied source.

## Train and evaluate a numeric model

E4 uses this Python image and adapter for the bounded [CPU ML workflow](ML.md).
Choose **Build and evaluate a CPU ML model** in the guide, approve an external
numeric CSV and quality thresholds, then train/evaluate and export safe JSON
weights. Training-only data enters a fixed standard-library recipe after package
preparation; independent fresh inference excludes project/dependency startup code.
No ML dependencies need to be added. Python source tests and model-quality
acceptance remain separate checks; arbitrary ML frameworks are not supported.

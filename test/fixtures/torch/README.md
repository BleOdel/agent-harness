# CPU checkpoint fixtures

`classifier.json` (step 21, crossing the scheduler's step-20 decay) and
`kmeans.json` (step 5) were produced by the actual fixed `src/torch/train.py`
recipe in the installed offline Linux CPU image:

`sha256:55a2958667abd8134bc8ad42241b308a0deeea885c6568790692bc0108603ebd`

The image contains PyTorch `2.14.0+cpu` and Python `3.13.12`. These are inert JSON,
not pickle. `generate.py` constructs the deterministic data and settings and
retains the binding alongside the real checkpoint. Run it inside that image
with `src/torch` mounted read-only at `/recipe`, this directory at `/fixtures`,
network disabled and a writable temporary `/tmp`. No downloads are needed.

The flat `test/torch-checkpoint.test.ts` suite clones each fixture before corrupting
one required component. Synthetic product-evidence fixtures borrow the valid RNG
encoding but remain labelled synthetic; their altered data are not training proof.
The validation receipt records source/fixture hashes and real runtime results.

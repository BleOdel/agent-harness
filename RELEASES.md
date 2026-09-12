# Release preparation and local staging

E9a prepares a release from one retained artifact. It saves a reviewed version and
exact destination, preserves the artifact independently of its producing run, and
stages checked bytes with a completion receipt. It never runs the artifact,
extracts an archive, applies source changes, signs files or uploads anything.

The only installed target is `local-directory@1`. External registries, GitHub
releases, app stores, signing and release credentials are future E9 work. Native,
mobile and GPU infrastructure remain deferred.

## Guided workflow

Run `harness guide` and choose **Prepare and stage a release**.

1. **Prepare a new release draft** lists eligible artifacts by name, verification
   status, size and creation time. Select the artifact, enter a release name and
   version, then select an existing local staging folder outside the project.
2. The draft shows the exact artifact hash, inherited verification, destination
   and output files. It saves its own retained reference; it writes nothing to
   the destination. You can leave and return without entering those choices again.
3. **Review and approve the saved draft** validates current bytes and destination,
   then asks for approval of that exact manifest. Declining keeps the draft.
4. **Dry run** checks the saved identity, approval, bytes and any existing staging
   files. It makes no destination changes. An unapproved draft may pass these
   checks but still explicitly requires approval before staging.
5. **Stage the approved artifact locally** writes into a private directory and
   writes the receipt last. Repeat or resume reconciles the same output; it does
   not silently create another release or replace existing files.
6. Inspect the manifest/result, verify an already-staged release, or retire it.
   Retirement releases its artifact-store reference and prevents further staging;
   it preserves the audit record and all files at the chosen destination. If reference
   cleanup was interrupted, the menu offers **Finish interrupted reference cleanup**.

No IDs or JSON edits are required in this workflow. Custom names, versions and a
local destination still require operator choices. Automated terminal tests cover
the complete workflow; human usability has not yet been measured.

## What approval means

Eligible artifacts must already be `diagnostics-passed` or `evaluation-passed`.
Their verification level is displayed and copied unchanged. Release preparation
checks identity and transfer, not product quality. A passing GUI diagnostic is not
independent acceptance evidence; a model evaluation applies only to its recorded
data and metrics. Neither label implies a product is ready for production.

The draft contains original provenance, a retained snapshot manifest, name,
version, target, filename, parent-directory filesystem identity and their digest.
Approval binds that digest. Editing a saved manifest invalidates it; create a new
draft for different bytes, version or destination. Deleting the original producer's
artifacts cannot remove the release's snapshot. Retiring the release allows generic
artifact cleanup to reclaim bytes once no other references need them.

Only one artifact is included. Dependencies, runtime binaries, companion documents,
installers and signatures are not assembled automatically. For an Electron ASAR,
the external runtime is still required; use the [desktop bundle export](DESKTOP.md)
when you need its runtime descriptor and GUI evidence together.

## Explicit commands

```bash
harness release setup
harness release list --json
harness release prepare <artifact-id> --name notes --version 1.0.0 --to /existing/output
harness release inspect <release-id>
harness release inspect <release-id> --json
harness release review <release-id>
harness release approve <release-id> --digest <reviewed-manifest-digest>
harness release dry-run <release-id> --json
harness release stage <release-id>
harness release retire <release-id> --yes
```

Only setup, review and guide require a terminal. Approval is separate from staging
and remains valid for retries of the unchanged manifest. No provider credentials,
network access or Docker are needed. `harness release stage` emits phase progress;
failures return a nonzero exit code with the saved reason.

Names use 1–60 lowercase letters, digits or hyphens. Versions use `1.2.3` or a
prerelease such as `1.2.3-beta.1`, at most 60 characters. The output directory is
`<selected-folder>/<name>-<version>` and contains:

| File | Purpose |
|---|---|
| `artifact-<original-basename>` | Exact retained artifact bytes |
| `release.json` | Frozen manifest and inherited provenance |
| `owner.json` | Identity of this harness release's staging directory |
| `receipt.json` | Completion marker binding release, manifest and artifact hash |

The directory is local review/staging output. A directory's existence alone does
not mean staging completed: a valid receipt and matching payload/manifest are
required. The manifest includes local paths for audit and is not a public-facing
release descriptor. Staged bytes remain inert; the harness never imports them.

## Recovery and safety boundary

Staging uses the existing project writer lock. It records intent before creating
output, writes complete temporary files, installs them with exclusive hard links,
flushes data/directories, and writes the receipt last. Successful retries verify
existing bytes and reuse the original receipt. Recognized pending hard links from
interrupted installation are reconciled; different bytes are never overwritten.

After controller loss, return to guide and recover the ended writer. Then select
the saved release and **Resume or reconcile interrupted staging**. A valid receipt
written before the final state update is reconciled as success. No new approval is
needed. A live writer cannot be displaced. SIGKILL recovery is tested after folder
reservation, artifact copy, manifest copy and receipt creation.

Ownership, symlink/hard-link, parent-directory replacement, unknown-file and hash
checks prevent a retry from claiming unrelated output. If the process dies between
creating the directory and completing an ownership marker, ownership may be
ambiguous. The harness refuses that directory; inspect it manually and use a new
draft/destination if needed. It never guesses ownership or removes the folder.
Modified or deleted completed outputs also cause refusal rather than recreation.

This relies on an operator-controlled local filesystem with hard links and fsync.
It does not promise transactional visibility of an entire directory, protection
against a malicious host process racing filesystem operations, or remote/network
filesystem durability. Staging consumers must verify the receipt and hashes.
Existing artifact limits apply: 32 MiB/file, 512 MiB retained blobs and 256 artifact
manifests. Snapshot references count toward that manifest limit; deduplicated bytes
are shared. Local staging copies have no aggregate disk quota.

`retire` keeps partial and completed destination files for inspection. It releases
only the artifact-store reference; `harness artifacts cleanup` removes unreferenced
blobs. It does not delete a local release or undo an external publication.

## Verification and example

`npm run verify:releases` runs deterministic identity, approval, dry-run, corruption,
reference-retention, ownership, interrupted-write, actual controller-crash and PTY
checks. It refuses skips and uses no provider or network. `npm run check` also
collects these tests. See [the release example](examples/releases/README.md).

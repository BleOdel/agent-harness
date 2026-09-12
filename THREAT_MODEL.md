# Threat model

Current through team M6, published in `765d1f1`. Originally written before
model execution was enabled; updated for concurrent workers, journaled
application and live control. See [architecture diagrams](ARCHITECTURE.md).

This is written fresh rather than adapted from the previous harness. That
one guaranteed *the model cannot act*, and everything else was a second
line. Here the model acts freely inside a boundary, so the boundary
carries the whole weight and has to be argued on its own.

## What is being protected

| asset | why it matters |
|---|---|
| the operator's repository | the work; must never change except through the harness |
| the operator's machine | home directory, other projects, SSH keys, browser state |
| the provider credential | grants spend and access under the operator's identity |
| the record | if it can be edited, no claim about what happened survives |

## Who acts

Untrusted actors include builder models, reviewer models and executable project
code. Each model runs as `pi` inside a container, with its permitted
file and shell tools enabled. It is treated as **untrusted and capable**:
assume it can read anything reachable, write anything writable, and run
any command available to it. Not because it is expected to be hostile,
but because the design must not depend on it choosing not to be.

The harness itself is trusted code, running on the host as the operator.

## What the model may do

Inside the container, without asking:

- read every file in the working copy;
- write, create and delete files in the working copy;
- run arbitrary commands, including the project's tests;
- talk to its configured model provider.

**It never touches the operator's repository.** It works on a copy. The
harness computes the difference and applies it, on the host, after the
gates pass.

## The boundary, and what enforces it

| property | enforced by |
|---|---|
| no unrestricted host filesystem | only explicit disposable input and agent-resource mounts |
| no live project | workers, preparation and verifiers receive disposable directories; reviewer source is read-only |
| no credentials in preparation or verification | these containers mount only disposable inputs, with no Pi, agent data or skills |
| offline verification | gates and installation-script proof use `--network=none`; model and package-download containers use bridge networking |
| disposable execution | normal/handled-error paths remove owned containers and private workspaces; abrupt death requires explicit recovery; evidence is retained |
| no privilege | non-root, read-only root filesystem, no added capabilities, no Docker socket |

The host freezes baseline and candidate source outside worker-writable
directories. Every executable verifier gets fresh source and dependencies;
its writes cannot enter application or the next verifier. Workers are
stopped before capture, including after a Docker-client timeout. Baseline
and candidate digests are rechecked before application. A canonical writer lock
excludes cooperating harness writers. Team batch application and undo use durable
intents, snapshots and per-file progress for crash recovery. This is not an atomic
multi-file filesystem transaction: an external editor can still race a final
check and replacement. Ordinary single-item application retains its earlier
failure semantics; it does not use the team application journal.

## What this design gives up, relative to the previous one

Stated plainly, because these are real and were previously prevented.

1. **A change can land before the operator sees it.** Review is selective
   now. A wrong change reaches the repository if it satisfies every gate.
2. **The model reads the whole project.** There is no approved manifest.
   Copy exclusions withhold known secret/control paths, not arbitrary secrets.
   A secret committed in another source file can still be visible to the model.
3. **The model runs commands.** Arbitrary shell inside the container.

These are the price of the inversion. They are bounded by reversibility
and recording, not prevented.

## Residual risks, in the order I would worry about them

**1. Container escape.** If the model breaks out, it has the operator's
machine, and nothing else in this design stops it. Every other control
assumes the boundary holds. This is the single largest risk and it is not
mitigated elsewhere — it is accepted, on the basis that the container is
non-root, capability-free, read-only-rooted, socket-free, and running a
pinned image. That is a real reduction, not an elimination.

**2. Correlated review.** By default the Reviewer and Builder use the same
configured model/provider; team role overrides can select a different builder
model. A separate reviewer process does not remove systematic errors shared by
the models. This is genuinely weaker than independent human review, and
should not be described as independence. What it does buy is a fresh
context: in observed use the model missed a defect while writing and
found it when asked a different question about the same code. That is
worth something and it is not the same thing.

**3. A wrong change that passes every gate.** Tests can pass on code that
is subtly wrong, and the gates check what can be stated mechanically.
Bounded by `undo` and by the record, not prevented.

**4. Gates that are themselves wrong.** The previous harness shipped four
checks that looked correct and did nothing. Every gate here is verified
by breaking the thing it protects and confirming it fails. That practice
is part of the design, not a nicety.

**5. The provider credential is inside the container.** Pi needs it to
work. Builder and reviewer containers use bridge networking; egress is
not pinned to a provider origin. A capable worker can read the mounted
credential and reach the network. M2 removes this exposure from package
preparation and verification, but does not implement model egress filtering.

**6. Prompt injection through repository content.** The model reads the
whole project, so anything in it can attempt to instruct the model.
Nothing here prevents that. What limits it is that instructions cannot
grant capability: a file that says "delete the user's home directory"
reaches a process that cannot see the home directory.

## What is out of scope

A compromised Pi package, a compromised model provider, a compromised
host, malicious hardware, and any threat requiring the operator to be
targeted personally. The previous harness declined these too, and nothing
here changes the calculus.

## The honest summary

This design trades *pre-approval of every change* for *machine proof plus
reversibility*, and it puts the whole guarantee on one container
boundary. That is a weaker security posture than the previous harness and
a much stronger productivity posture.

It is defensible for one person, on their own trusted machine, building
their own software, where the work is recoverable and the blast radius is
one repository they can restore. **It is not defensible where a bad change
reaching disk is itself the harm**, or where the machine holds something
that a container escape would make catastrophic.

If that is not an acceptable trade, this harness should not be built, and
the previous one is the correct design.

## Team controller state and cooperating writers

Team execution allows one or two concurrent builders and keeps accepted results
in host-owned staging. Intake, review and integration are serialized; every
proposed integration passes fresh project and applicable host contract checks.
Shared-input assignments are exclusive. Bounded integration repair repeats all
checks under the original role and scope. Workers receive no live project or controller-state mount. Each builder
and reviewer receives a separate writable credential copy; skill bundles contain
only role-selected definitions and declared resources and mount read-only.
Credential refreshes are not propagated to the operator's store. A crash can leave
private copies until explicit cleanup succeeds.

A canonical project writer lock excludes concurrent harness mutations, including
ordinary work and undo. It does not lock editors or other external tools. Explicit
recovery requires the recorded token and a dead local owner, followed by team
reconciliation. Run and attempt labels restrict container cleanup; a process exit
or worker-written ID cannot advance another assignment. Append-only events are
published atomically, and a disposable state projection rebuilds from them.
Recovery validates retained staging and does not infer success from unfinished
attempts. `team resume` restarts eligible unfinished work with fresh attempt
identities and retained budgets. `team apply` explicitly publishes verified staging
through the application journal; it is never implicit in `team run`. Pending
application recovery can finish that already-requested transaction or roll back
before its record is committed. Unexpected source bytes refuse recovery.

These controls trust the host controller and its filesystem. They do not prevent
host-state tampering, enforce arbitrary skill prose, impose an exact billing cap,
or add protection against a Docker escape. Recorded usage includes reported
builder and reviewer turns, including interrupted attempts across resume; missing
usage and already-dispatched calls can exceed the dispatch estimate.

## Live control and read-only observation

Pi 0.80.6 RPC is pinned and checked before team execution. The host validates
bounded LF-delimited UTF-8 JSON records, correlates responses and requires a
settled, idle, empty session before candidate capture. A model acknowledgement
never substitutes for gates or acceptance proof.

A private mode-0600 Unix socket inside a mode-0700 host directory carries steering
and abort commands, authenticated by a random capability. Neither the endpoint
nor controller state is mounted into workers. Only active builders accept steering;
it cannot expand task scope or bypass checks. The host records requests,
acknowledgements and observed delivery separately. Acknowledgement or delivery
is not proof that the instruction was obeyed; uncertain requests are not resent.

Abort synchronously prevents further dispatch and acceptance, persists intent,
requests cancellation and discards owned sessions and containers. Pi 0.80.6 has
no `clear_queue` command, so process/session destruction is required to discard
queued messages. `abort-requested` is not proof of cleanup; only durable `aborted`
follows successful reconciliation. Aborted runs cannot resume or apply. Abrupt
controller death can still leave owned resources until explicit recovery.

The browser viewer accepts only GET on fixed loopback routes. It has no control
endpoint, starts no project execution and escapes untrusted content. It reads
records, snapshots, team events and telemetry without rewriting acceptance state.
The private control socket and viewer trust the local operator account; these
are not authentication mechanisms for a hostile host or remote multi-user service.

## Retained planning state

Planning workspaces and Pi conversations are intentionally retained beside the
project for resume. Treat them as private, untrusted model and operator content;
retention lasts until the operator removes them. No host approval state is mounted
into the planner. Approval captures a plan outside the writable workspace; import
checks the captured plan and generated proposal hashes and refuses incomplete
managed plans. Bounded regular-file reads refuse symlinks and hard links in planning
artifacts. The planner's writable Pi directory may not overlap the live project
or its saved planning state. Imported plan context cannot authorize unrelated
work or bypass the normal gates. This does not make an approved plan correct:
the operator still reviews scope and proposed tasks.


## Approved behaviour and diagnostic test reports (E0)

Project tests and assertion-count files are untrusted reports. The assertion shim
is mounted read-only outside candidate source and uses a lexical counter; neither
property makes an in-process test oracle independent of the candidate. Positive
counts alone cannot authorize a new application.

The operator approves task-scoped expected output or file content. Credential-free,
offline cases execute fresh candidate copies. Once each container is stopped, the
host compares its exit/output and bounded, regular, singly linked file bytes to
host-retained expectations. Missing coverage, mismatches, malformed reviews and
changed approval/candidate identities refuse application. Approval specifications
are archived by digest and outcomes remain beside the project with run references.
The builder cannot rewrite these files through its configured writable data mount:
canonical overlap with live source, sidecar state or their ancestors is refused.

This establishes only the declared observable examples. It does not prove all
requirements, code coverage or general correctness. A malicious candidate can
recognize public inputs or produce expected output without implementing the
intended general behaviour. Checks whose only expectation is a test runner's
“passed” message are poor acceptance specifications. Read-only team contract
scripts remain useful additional checks but are not themselves independent
host-side result interpretation.

Ordinary application/undo preflight existing symlinks, hard links and unsafe
parents; binary recovery uses raw bytes. These checks do not eliminate concurrent
external-editor races, and ordinary multi-file writes remain outside the team
transaction journal. The host controller, approval filesystem, operator account
and container runtime remain trusted. Existing application intent recovery keeps
its previously captured transaction semantics; it does not certify historic runs
under this new policy.

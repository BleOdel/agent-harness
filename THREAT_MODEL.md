# Threat model

Written before any code that lets the model write, because in this design
containment is not defence in depth — it is the entire guarantee.

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

One actor: an AI model, running as `pi` inside a container, with its own
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
| no persistence | the container and copy are destroyed after every run |
| no privilege | non-root, read-only root filesystem, no added capabilities, no Docker socket |

The host freezes baseline and candidate source outside worker-writable
directories. Every executable verifier gets fresh source and dependencies;
its writes cannot enter application or the next verifier. Workers are
stopped before capture, including after a Docker-client timeout. Baseline
and candidate digests are rechecked before application. This does not yet
provide a writer lock or crash-consistent multi-file transaction; an edit
after the final check remains a race until team M5. Every applied write is
snapshotted first.

## What this design gives up, relative to the previous one

Stated plainly, because these are real and were previously prevented.

1. **A change can land before the operator sees it.** Review is selective
   now. A wrong change reaches the repository if it satisfies every gate.
2. **The model reads the whole project.** There is no approved manifest.
   Anything in the repository is visible to it, including anything
   committed there by mistake.
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

**2. Correlated review.** The Reviewer is the same model, from the same
provider, as the Builder. A systematic blind shared by both is invisible
to both. This is genuinely weaker than independent human review, and
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

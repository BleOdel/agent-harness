# Harness skill assessment

8 September 2026 · Harness `0cc7c34` · Installed Pi `0.80.6`

Assessed `/Users/blessingodeleye/Developer/agent-skills/` and the harness's actual launch code. Skill instructions were inspected as project inputs, not invoked as instructions for this assessment. This records the pre-M0 assessment. M0 launcher fixes and verification are described in `TEAM_M0_RESULTS.md`; the original skill definitions remain unchanged.

## Result

All six skill definitions load through the installed Pi parser with no diagnostics. Five appear in the model's skill catalog; `grill-me` is hidden by `disable-model-invocation: true`. Valid metadata does not establish that a workflow is compatible with the harness or was used in a run.

The folder contains useful design, testing and diagnosis guidance. Several workflows assume a human conversation or tools the default Pi builder does not have. Adapt and select skills by role before using this folder for unattended teams.

## What happens today

The harness configuration sets `HARNESS_SKILLS=/Users/blessingodeleye/Developer/agent-skills`. The host scanner walks the directory, reports folder names containing `SKILL.md`, and mounts the configured folder read-only at `/opt/skills`.

| Stage | Current behavior |
|---|---|
| `harness plan` | Interactive Pi invocation; passes the entire skill directory and asks for the grilling skill when either grilling name is discovered |
| `harness work` / sequential `run` | Passes the entire directory to a noninteractive builder; no per-role selection |
| Reviewer | Explicitly passes `--no-skills` and `--no-extensions`; its mount layout can still contain the skill directory, so discovery is disabled rather than the files being absent |
| Verification gates | Ordinary checks; no model selecting skills |

Pi puts skill names, descriptions and file locations in its prompt, then the model can read the full instructions when relevant. It supports explicit `/skill:name` commands. The harness's folder listing is neither a list of all skills Pi resolved nor a record of full instructions read. [Pi skill documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

The installed loader reads `SKILL.md` frontmatter; it does not translate `agents/openai.yaml` into Pi agent roles, tool registrations or policy enforcement. Supporting Markdown and scripts are resources for the model to read or execute deliberately. A skill does not automatically create another agent.

## Findings requiring implementation changes

### 1. An explicit skill directory does not turn off other discovery

`src/agent/pi.ts:49` passes either `--skill /opt/skills` or `--no-skills`. With skills enabled, the first form adds the directory to Pi's other resolved skill sources. `src/verbs/plan.ts:139` does the same.

A controlled probe against installed Pi reproduced the difference using a synthetic skill in an isolated agent data directory:

| Loader configuration | Six configured skills loaded | Synthetic extra skill loaded |
|---|---|---|
| Explicit directory, discovery enabled | Yes | Yes |
| Explicit directory, discovery disabled | Yes | No |

Use `--no-skills --skill /opt/skills` for explicit-only loading, or repeated explicit paths for selected skills. Pi documents that explicit paths still load when discovery is disabled. [Discovery flags](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

This corrects the earlier assessment's implication that configuring this folder exclusively controls which skills are available. The probe demonstrates additional discovery is possible; it does not claim an unwanted skill has affected an actual historical run.

### 2. Planning does not explicitly disable extensions

The builder and reviewer include `--no-extensions`. The actual interactive command in `src/verbs/plan.ts:134–143` omits it. This conflicts with the repository's general statement that extensions are always off.

Put common resource-loading policy in one shared launcher helper, including the planning path. The absence of the flag allows applicable discovery; this assessment did not load or execute any existing extensions to demonstrate it.

### 3. Interaction requirements are not a loading policy

`disable-model-invocation` controls whether Pi advertises a skill to the model; it does not identify all human-dependent workflows and is not a security boundary. Only `grill-me` sets it. `grilling` is advertised to the unattended builder despite explicitly requiring questions and answers.

Likewise, `tdd` requires confirmation of test interfaces, and the diagnosis and domain-modeling workflows contain human interaction paths. Filtering only on that frontmatter field would miss these cases.

### 4. The record cannot establish which skills influenced a result

`listSkills()` reports directory names without checking full metadata or tool requirements. The event renderer preserves text and usage, but does not produce a structured skill-read audit. Run records have no resolved skill manifest or content digests.

Record separate facts: which skill versions were made available, which files were observed being read, and which workflow evidence the candidate supplied. Reading instructions does not prove compliance; a self-reported skill name does not prove the instructions were read.

## Assessment of each skill

| Skill | Useful role | Compatibility issue | Proposed treatment |
|---|---|---|---|
| `tdd` | Builder and repair | Requires confirmed test interfaces; calls a `Skill` tool; refers to absent `code-review` skill | Create an unattended variant consuming interfaces already accepted in the task brief; read reference files through Pi's `read` tool; remove or replace the missing dependency |
| `codebase-design` | Planner/architect; scoped builder design | Optional `DESIGN-IT-TWICE.md` requires 3+ subagents; vocabulary bans ordinary terms such as API and boundary | Keep core guidance; allow project-specific terminology; make alternative designs a host-assigned workflow or a sequential local exercise |
| `diagnosing-bugs` | Integration repair | Includes user questions, human-input script, browser/tool assumptions and git bisection | Keep automated reproduction and hypothesis testing; turn unavailable-environment/human requirements into structured blocked output; never wait for terminal input in a builder |
| `domain-modeling` | Planner/architect | Requires discussion and writes shared glossary/ADR files | Assign shared-document changes to a dedicated task; provide accepted glossary to builders; other workers submit proposed terminology changes |
| `grilling` | Interactive planning | Requires human answers and delegates fact-finding to subagents | Keep the interview in planning; use local file inspection until controller-managed research assignments exist; do not offer it to unattended builders |
| `grill-me` | Optional interactive alias | Its entire body calls a nonexistent default Pi `Skill` tool with `grilling`; hidden from model catalog | Prefer `/skill:grilling` directly, or create a Pi-compatible wrapper that reads the actual grilling file |

Specific supporting-file observations:

- `codebase-design/DESIGN-IT-TWICE.md` delegates parallel design alternatives. This is an optional referenced workflow, not evidence that the harness already has delegation.
- `diagnosing-bugs/scripts/hitl-loop.template.sh` uses shell `read` and expects terminal responses. The unattended builder has no operator input channel.
- `tdd/SKILL.md` refers to `code-review`, which is not present in the supplied folder. The harness's fixed acceptance reviewer is not an implementation of that missing skill.
- TDD examples use `expect`/Jest-style syntax. Adapt examples to the project's configured runner and assertion counter; their instructional presence alone does not mean tests were written incorrectly.
- Domain-modeling's sequential ADR numbering would collide if multiple isolated workers independently allocate the same next number. Assign shared-document ownership or allocate IDs through the controller.

## Proposed role profiles

These profiles require the adaptations above; they are not current harness features.

| Profile | Skills made available | Operating rule |
|---|---|---|
| Interactive planner | Adapted `grilling`, `domain-modeling`, core `codebase-design` | Human can answer; output accepted tasks, test interfaces, contracts and shared-document ownership |
| Builder | Unattended `tdd`, core `codebase-design` when relevant | Work from the accepted brief; missing decisions become blocked submissions |
| Integration repair | Unattended `diagnosing-bugs`, unattended `tdd` | Use the assigned failure and repair scope; bounded attempts |
| Reviewer | None | Preserve fixed acceptance instructions and read-only tools |
| Gates/controller | None | Enforce programmed checks and scheduling policies |

Use a host-side manifest for explicit skill dependencies, required capabilities and interaction mode. These are proposed harness fields, not existing Pi semantics. Resolve the manifest to a per-attempt snapshot containing selected definitions and their required resources; mount only that snapshot read-only. Record hashes for the whole bundle, including supporting scripts and documents.

For required skills, explicitly instruct the worker to read the selected file and provide task-specific workflow evidence. For TDD, that can include the accepted test interface, failing-before-fix result and passing-after-fix result. Host-controlled checks still decide acceptance. Avoid turning skill prose into automatic filesystem or tool authority.

## Verification and next changes

Completed for this assessment:

- Parsed the six real definitions with installed Pi 0.80.6: zero diagnostics.
- Verified model-catalog visibility: five visible, `grill-me` hidden.
- Reproduced additive versus explicit-only discovery in isolated temporary directories, without model calls or credentials.
- Ran the existing skill and planning tests: 12 passed. These tests do not currently catch the discovered launcher gaps.
- Read the supporting documents and human-input script without executing their workflows.

No live model run was used to test how faithfully any skill is followed.

Implement explicit-only discovery and consistent extension policy first. Then introduce adapted role profiles, missing-capability validation and skill-version records before M3's unattended team assignments. Add regression cases for extra global/project skills, duplicate names, an interactive skill in a builder profile, missing referenced resources, read-only mounts and skill-file changes between attempts. Keep a real Pi loader integration test pinned to the configured version.

## M3 unattended adaptations

M3 adds host-managed role manifests and separate instruction variants under
`profiles/skills/`. The supplied folder remains unchanged and was treated as
source material, not instructions authorizing harness actions.

- TDD consumes accepted interfaces and project conventions, blocks on missing
  decisions, reads resources with Pi's `read` tool, and uses the host reviewer
  instead of the absent `code-review` skill.
- Core design retains small interfaces and local reasoning, permits accepted
  project vocabulary, and compares alternatives sequentially without subagents.
- Diagnosis keeps reproduction, competing hypotheses and regression evidence.
  Missing environments or human input become structured blocked submissions.
- Interview skills and the `grill-me` wrapper are excluded from unattended roles.
  Interactive planning remains the existing operator conversation.

`profiles/team.json` includes the builder profile and an available diagnosis skill
for a separately accepted repair role. M3 does not implement automatic repair.
The host validates names, interaction mode, tool requirements, dependency cycles,
and declared supporting files, then snapshots selected inputs into each attempt.
Pi loader verification covers adapted builder and repair bundles. Available file
hashes, successful read-tool observations and worker-reported workflow evidence
are separate event fields. Tool observations can be partial reads, and neither
those observations nor the worker's report proves faithful execution of a skill.

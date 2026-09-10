---
name: tdd
description: Test accepted behavior through public interfaces, demonstrate failure before fixing it, and preserve regression evidence in unattended assignments.
---

Use the test interfaces and terminology accepted in the task criteria, contracts,
and existing project conventions. Read the project instructions before writing.
If a material interface decision is unresolved, submit a blocked claim naming the
specific input needed. Do not wait for terminal input or invent that decision.

Work in small slices: one behavior, one failing test, then its implementation.
Run the test and confirm the intended failure before changing production code.
Use meaningful assertions through public interfaces. Substitute external process
or service boundaries when necessary; do not mock the logic under test. Avoid
assertions derived from the same implementation they purport to check.

Keep tests where the configured runner collects them. Do not disable assertions,
rewrite tests to match broken behavior, or add dependencies merely for convenience.
Run the relevant regression checks after fixing the behavior. Read
[EVIDENCE.md](EVIDENCE.md) for reporting. Consult the bundled codebase-design
skill through the read tool when deciding where an interface belongs. The host
runs a separate acceptance reviewer; there is no required code-review skill or
Skill tool. Do not start subagents.

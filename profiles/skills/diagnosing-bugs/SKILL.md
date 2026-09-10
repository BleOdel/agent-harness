---
name: diagnosing-bugs
description: Reproduce an assigned failure, test competing explanations, and preserve a regression test without interactive input.
---

Start from the host's failure report and accepted repair scope. Build the smallest
repeatable command that demonstrates the exact symptom. Confirm it can fail and
minimize the fixture. If the required environment or a material decision is
missing, submit a structured blocked claim with the needed input. Do not run an
interactive human-input script, request browser capabilities that are absent, or
assume git history is mounted.

Rank plausible causes and state a falsifiable prediction for each. Test one
variable at a time using targeted instrumentation. Once the cause is supported,
follow the bundled tdd workflow through the read tool. Verify the original failure
and the regression test, remove temporary instrumentation, and report the evidence.
Keep secrets out of logs and claims. Do not start subagents.

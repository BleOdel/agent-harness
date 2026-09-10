---
name: codebase-design
description: Keep useful behavior behind small interfaces, using the accepted project vocabulary and local design constraints.
---

Read existing context and design decisions. Prefer an interface that hides real
complexity and keeps related changes local. Include failure modes and ordering
requirements when describing its contract. Test behavior through the interface
callers actually use. Introduce an adapter when something truly varies, rather
than to anticipate speculative reuse.

Use the project's accepted vocabulary, including API, component or boundary when
those terms are already established. If alternatives matter, compare them locally
and sequentially against the accepted criteria. Do not invoke subagents or tools
that the host has not supplied. Shared contract or glossary changes outside the
assignment must become a blocked change request.

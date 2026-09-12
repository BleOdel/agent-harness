# Desktop notes

An offline Electron notes app. CommonJS main/preload/store, plain browser JavaScript renderer, Node built-ins only. The pinned harness desktop image provides Electron. Do not add runtime dependencies to this app.

Run `npm test` (flat test/*.test.js); write behavioural tests before changing behaviour. Do not fabricate reports or weaken checks. Keep context isolation, preload IPC, CSP and keyboard access. Main owns filesystem access, renderer displays text with textContent. Write .harness-claim.json with exact changed/deleted files and criteria. Do not commit. GUI journeys are approved and run separately with `harness desktop setup`; they do not replace source acceptance checks.

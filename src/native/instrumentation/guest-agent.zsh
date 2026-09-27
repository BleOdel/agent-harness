#!/bin/zsh -f
# Installed only in a trusted, source-free preparation VM. Each verification
# uses a disposable clone and a read-only input share with no expected values.
set -eu
input='/Volumes/My Shared Files/harness-input'
for attempt in {1..600}; do
  if [[ -f "$input/launch.zsh" ]]; then
    exec /bin/zsh -f "$input/launch.zsh"
  fi
  /bin/sleep 0.2
done
exit 70

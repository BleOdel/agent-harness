set -eu
/usr/bin/swiftc train.swift -framework Metal -o /tmp/harness-metal-trainer
/tmp/harness-metal-trainer input.json checkpoint.json

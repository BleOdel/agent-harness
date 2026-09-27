#!/bin/zsh -f
set -eu
root='/Volumes/My Shared Files/harness-prepare'
/bin/mkdir -p /usr/local/lib/harness
/usr/bin/install -o root -g wheel -m 755 "$root/guest-agent.zsh" /usr/local/lib/harness/guest-agent.zsh
/bin/cat > /Library/LaunchDaemons/local.harness.native.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.harness.native</string><key>UserName</key><string>admin</string><key>ProgramArguments</key><array><string>/bin/zsh</string><string>-f</string><string>/usr/local/lib/harness/guest-agent.zsh</string></array><key>RunAtLoad</key><true/></dict></plist>
PLIST
/usr/sbin/chown root:wheel /Library/LaunchDaemons/local.harness.native.plist
/bin/chmod 644 /Library/LaunchDaemons/local.harness.native.plist
/usr/bin/sw_vers -productVersion
/usr/bin/uname -m
/usr/bin/xcrun swiftc --version

set -eu
# All paths and permission grants below belong to the disposable guest only.
root=/private/tmp/harness-work
/usr/bin/xcrun swiftc -swift-version 5 -parse-as-library apple-driver.swift -o "$root/AXDriver"
/usr/bin/codesign --force --sign - "$root/AXDriver"
for service in Accessibility ScreenCapture PostEvent; do
 /usr/bin/sudo -n /usr/bin/sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier) VALUES ('kTCCService${service}','/private/tmp/harness-work/AXDriver',1,2,4,1,'UNUSED');"
done
uid=$(/usr/bin/id -u admin)
for attempt in {1..60}; do /bin/launchctl print gui/$uid >/dev/null 2>&1 && break; /bin/sleep 0.5; done
/usr/bin/sudo -n /bin/launchctl asuser "$uid" /usr/bin/sudo -n -u admin /usr/bin/env -i HOME=/Users/admin TMPDIR=/private/tmp PATH=/usr/bin:/bin:/usr/sbin:/sbin "$root/AXDriver"

set -eu
mkdir -p build/Notes.app/Contents/MacOS
/usr/bin/xcrun swiftc -swift-version 5 -parse-as-library main.swift -o build/Notes.app/Contents/MacOS/Notes
cat > build/Notes.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Notes</string><key>CFBundleIdentifier</key><string>local.harness.native-notes</string><key>CFBundleName</key><string>Notes</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
/usr/bin/codesign --force --sign - build/Notes.app

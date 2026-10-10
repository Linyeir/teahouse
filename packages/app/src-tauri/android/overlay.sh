#!/bin/sh
# Applies Teahouse's changes to the Android project that `tauri android init` generates in
# gen/android: the app icons, and the network security config, which lets the app trust CAs
# installed on the phone (see res/xml/network_security_config.xml). Run it after every init.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
project="$here/../gen/android/app/src/main"
manifest="$project/AndroidManifest.xml"
[ -f "$manifest" ] || { echo "No Android project; run 'tauri android init' first" >&2; exit 1; }

# init writes the template's default icons; Tauri does not pick up icons/android itself.
cp -r "$here/../icons/android/." "$project/res/"
cp -r "$here/res/." "$project/res/"

if ! grep -q 'android:networkSecurityConfig' "$manifest"; then
  sed -i.bak 's|<application|<application android:networkSecurityConfig="@xml/network_security_config"|' "$manifest"
  rm -f "$manifest.bak"
fi
grep -q 'android:networkSecurityConfig="@xml/network_security_config"' "$manifest" || {
  echo "Could not add the network security config to $manifest" >&2
  exit 1
}

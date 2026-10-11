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

# The native transport (src/transport/android.rs) calls into the Kotlin component of
# rustls-platform-verifier; its version must be the one of rustls-platform-verifier-android in
# Cargo.lock.
gradle="$here/../gen/android/app/build.gradle.kts"
version=$(awk '/^name = "rustls-platform-verifier-android"$/ { getline; gsub(/version = |"/, ""); print; exit }' "$here/../Cargo.lock")
[ -n "$version" ] || { echo "rustls-platform-verifier-android not found in Cargo.lock" >&2; exit 1; }
if ! grep -q 'org.rustls:rustls-platform-verifier' "$gradle"; then
  {
    echo ''
    echo '// Added by android/overlay.sh'
    echo 'repositories {'
    echo '    maven { url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/") }'
    echo '}'
    echo 'dependencies {'
    echo "    implementation(\"org.rustls:rustls-platform-verifier:$version\")"
    echo '}'
  } >> "$gradle"
fi
sed -i.bak "s|org.rustls:rustls-platform-verifier:[0-9][^\"]*|org.rustls:rustls-platform-verifier:$version|" "$gradle"
rm -f "$gradle.bak"
grep -q "org.rustls:rustls-platform-verifier:$version" "$gradle" || {
  echo "Could not add rustls-platform-verifier to $gradle" >&2
  exit 1
}

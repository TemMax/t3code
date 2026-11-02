#!/usr/bin/env bash
# TemMax/t3code fork only: builds the iOS app from a git ref and uploads it to TestFlight.
# Signing is automatic through the Apple account signed in to Xcode (team 93FFKDMA3D).
#
#   scripts/fork-ios-testflight.sh [ref] [--no-upload]
#
# ref defaults to origin/main. The build runs in its own worktree (T3CODE_FORK_IOS_BUILD_DIR,
# default ~/.t3/worktrees/t3code/ios-testflight) so no checkout's ios/ dev project is replaced.
# T3CODE_MOBILE_VERSION overrides the marketing version.
set -euo pipefail

ref="origin/main"
upload=1
for arg in "$@"; do
  case "$arg" in
    --no-upload) upload=0 ;;
    *) ref="$arg" ;;
  esac
done

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
build_dir="${T3CODE_FORK_IOS_BUILD_DIR:-$HOME/.t3/worktrees/t3code/ios-testflight}"
team_id="93FFKDMA3D"

git -C "$repo" fetch origin --quiet
if [ -e "$build_dir/.git" ]; then
  git -C "$build_dir" checkout --quiet --force --detach "$ref"
else
  git -C "$repo" worktree add --detach "$build_dir" "$ref"
fi
commit="$(git -C "$build_dir" rev-parse --short HEAD)"

build_number="$(date -u +%Y%m%d%H%M)"
out_dir="$build_dir/.t3/ios-testflight/$build_number"
mkdir -p "$out_dir"
log="$out_dir/build.log"
echo "Building $ref ($commit) as build $build_number; log: $log"

run() {
  if ! "$@" >>"$log" 2>&1; then
    echo "Failed: $*" >&2
    tail -n 60 "$log" >&2
    exit 1
  fi
}

vp="$(command -v vp || echo "$repo/node_modules/.bin/vp")"
cd "$build_dir"
run "$vp" i

cd apps/mobile
export APP_VARIANT=production
export T3CODE_FORK_IOS=1
export T3CODE_MOBILE_UPDATES_ENABLED=0
export T3CODE_MOBILE_BUILD_NUMBER="$build_number"
export EXPO_NO_GIT_STATUS=1
run ./node_modules/.bin/expo prebuild --clean --platform ios

workspace="$(ls -d ios/*.xcworkspace | head -n 1)"
scheme="$(basename "$workspace" .xcworkspace)"
archive="$out_dir/$scheme.xcarchive"
run xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -destination generic/platform=iOS -archivePath "$archive" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team_id" archive

destination="export"
[ "$upload" = 1 ] && destination="upload"
cat >"$out_dir/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$team_id</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
run xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out_dir/export" \
  -exportOptionsPlist "$out_dir/ExportOptions.plist" -allowProvisioningUpdates

if [ "$upload" = 1 ]; then
  echo "Uploaded build $build_number ($commit) to App Store Connect; TestFlight lists it after processing."
else
  echo "Exported build $build_number ($commit) to $out_dir/export"
fi

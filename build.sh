#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VERSION=$(<"$ROOT/VERSION")
NAME=openclaw-express-bridge
ARCH=amd64
OUT=${OUT_DIR:-"$ROOT/../../dist/express-pack"}
BUILD="$ROOT/.build"
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1784642400}
export SOURCE_DATE_EPOCH

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing build command: $1" >&2; exit 1; }; }
for cmd in dpkg-deb find gzip npm rsync sha256sum tar; do need "$cmd"; done

rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT"

echo "== plugin: deterministic npm install and verification =="
(
  cd "$ROOT/plugin"
  npm ci --ignore-scripts
  npm test
  npm run lint
  npm run typecheck
  npm run format:check
)

copy_runtime() {
  local dest=$1
  mkdir -p "$dest"/{bin,lib,helpers,systemd,plugin}
  rsync -a "$ROOT/bin/" "$dest/bin/"
  rsync -a "$ROOT/lib/" "$dest/lib/"
  rsync -a "$ROOT/helpers/" "$dest/helpers/"
  rsync -a "$ROOT/systemd/" "$dest/systemd/"
  rsync -a --exclude node_modules --exclude .eslintcache "$ROOT/plugin/" "$dest/plugin/"
  mkdir -p "$dest/plugin/node_modules"
  cp -a "$ROOT/plugin/node_modules/zod" "$dest/plugin/node_modules/"
  install -m 644 "$ROOT/VERSION" "$ROOT/LICENSE" "$ROOT/client.env" "$dest/"
}

normalize_tree() {
  local tree=$1
  find "$tree" -print0 | xargs -0 touch --no-dereference --date="@$SOURCE_DATE_EPOCH"
  find "$tree" -type d -exec chmod 755 {} +
  find "$tree" -type f -exec chmod 644 {} +
  find "$tree" -type f \( \
    -path '*/bin/openclaw-express-bridge' -o \
    -path '*/lib/express-keyring-service.sh' -o \
    -path '*/helpers/cdp-screenshot.mjs' -o \
    -name install.sh -o -name uninstall.sh \) -exec chmod 755 {} +
  find "$tree" -type f -name eXpress.AppImage -exec chmod 700 {} +
}

build_tar() {
  local variant=$1 private_client=${2:-}
  local top="$NAME-$VERSION"
  local stage="$BUILD/tar-$variant/$top"
  mkdir -p "$stage"
  copy_runtime "$stage"
  install -m 755 "$ROOT/install.sh" "$ROOT/uninstall.sh" "$stage/"
  install -m 644 "$ROOT/README.md" "$stage/"
  if [[ -n "$private_client" ]]; then
    mkdir -p "$stage/client"
    install -m 700 "$private_client" "$stage/client/eXpress.AppImage"
  fi
  normalize_tree "$BUILD/tar-$variant"
  local suffix=""
  [[ "$variant" == public ]] || suffix=-private
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
    -C "$BUILD/tar-$variant" -cf - "$top" | gzip -n -9 > \
    "$OUT/$NAME${suffix}-$VERSION-linux-amd64.tar.gz"
}

build_deb() {
  local variant=$1 private_client=${2:-}
  local stage="$BUILD/deb-$variant"
  mkdir -p "$stage/DEBIAN" "$stage/usr/lib/$NAME" "$stage/usr/bin" \
    "$stage/usr/share/doc/$NAME"
  copy_runtime "$stage/usr/lib/$NAME"
  install -m 755 "$ROOT/bin/openclaw-express-bridge" "$stage/usr/bin/"
  install -m 644 "$ROOT/README.md" "$ROOT/LICENSE" "$stage/usr/share/doc/$NAME/"
  install -m 644 "$ROOT/packaging/debian/control" "$stage/DEBIAN/control"
  install -m 755 "$ROOT/packaging/debian/postinst" "$ROOT/packaging/debian/prerm" "$stage/DEBIAN/"
  if [[ -n "$private_client" ]]; then
    mkdir -p "$stage/usr/lib/$NAME/client"
    install -m 700 "$private_client" "$stage/usr/lib/$NAME/client/eXpress.AppImage"
  fi
  normalize_tree "$stage"
  chmod 755 "$stage/DEBIAN/postinst" "$stage/DEBIAN/prerm" "$stage/usr/bin/openclaw-express-bridge"
  local suffix=""
  [[ "$variant" == public ]] || suffix=-private
  dpkg-deb --root-owner-group --build "$stage" "$OUT/${NAME}${suffix}_${VERSION}_${ARCH}.deb" >/dev/null
}

echo "== packaging smoke tests =="
"$ROOT/tests/run.sh"

echo "== redistributable artifacts =="
build_tar public
build_deb public

private_client=${EXPRESS_PRIVATE_CLIENT:-}
if [[ -n "$private_client" ]]; then
  [[ -f "$private_client" ]] || { echo "private client not found: $private_client" >&2; exit 1; }
  expected=$(awk -F= '$1=="EXPRESS_CLIENT_SHA256" {print $2}' "$ROOT/client.env")
  actual=$(sha256sum "$private_client" | awk '{print $1}')
  [[ "$actual" == "$expected" ]] || { echo "private client SHA256 mismatch" >&2; exit 1; }
  echo "== private authorized artifacts =="
  build_tar private "$private_client"
  build_deb private "$private_client"
else
  echo "SKIP private bundle (set EXPRESS_PRIVATE_CLIENT to authorized AppImage)"
fi

echo "== public artifact client exclusion check =="
! tar -tzf "$OUT/$NAME-$VERSION-linux-amd64.tar.gz" | grep -q 'eXpress.AppImage'
! dpkg-deb -c "$OUT/${NAME}_${VERSION}_${ARCH}.deb" | grep -q 'eXpress.AppImage'

echo "== artifact secret scan =="
scan_dir="$BUILD/public-scan"
mkdir -p "$scan_dir/tar" "$scan_dir/deb"
tar -C "$scan_dir/tar" -xzf "$OUT/$NAME-$VERSION-linux-amd64.tar.gz"
dpkg-deb -x "$OUT/${NAME}_${VERSION}_${ARCH}.deb" "$scan_dir/deb"
"$ROOT/tests/scan-secrets.sh" "$scan_dir"

(cd "$OUT" && sha256sum ./*"$VERSION"* > SHA256SUMS)
printf '\nBuilt artifacts:\n'
find "$OUT" -maxdepth 1 -type f -printf '%f %s bytes\n' | sort
printf '\nSHA256:\n'
cat "$OUT/SHA256SUMS"

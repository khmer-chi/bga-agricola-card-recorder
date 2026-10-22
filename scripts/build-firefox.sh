#!/bin/sh
# Builds the Firefox (desktop + Android) version into dist/firefox and zips it for
# signing on addons.mozilla.org. Same source as Chrome; only the manifest differs, and
# the dev-only auto-reload worker (src/background.js) is left out.
set -e
cd "$(dirname "$0")/.."
rm -rf dist/firefox dist/bga-agricola-card-recorder-firefox.zip
mkdir -p dist/firefox/src
cp manifest.firefox.json dist/firefox/manifest.json
cp src/inject.js src/content.js dist/firefox/src/
(cd dist/firefox && zip -qr ../bga-agricola-card-recorder-firefox.zip .)
echo "built dist/firefox and dist/bga-agricola-card-recorder-firefox.zip"

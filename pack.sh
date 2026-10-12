#!/bin/sh
# Builds the zip to upload to https://extensions.gnome.org/upload/
set -e
cd "$(dirname "$0")"
UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
mkdir -p dist
gnome-extensions pack . --force --out-dir=dist \
    --extra-source=LICENSE \
    --schema=schemas/org.gnome.shell.extensions.magnify-dock.gschema.xml
echo "Created: $(pwd)/dist/$UUID.shell-extension.zip"

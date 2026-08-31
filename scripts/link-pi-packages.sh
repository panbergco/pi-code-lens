#!/bin/bash
# The extension ships as TypeScript for pi to load, so testing its real wiring
# means compiling it and running it against pi's own packages. Find them from
# the installed binary rather than assuming an install layout.
set -e
P=$(readlink -f "$(command -v pi)")
while [ "$P" != "/" ] && [ ! -f "$P/package.json" ]; do P=$(dirname "$P"); done
[ -d "$P/node_modules" ] || { echo "pi packages not found (looked in $P)" >&2; exit 1; }
mkdir -p .test-dist/node_modules/@earendil-works
ln -sfn "$P" .test-dist/node_modules/@earendil-works/pi-coding-agent
ln -sfn "$P/node_modules/@earendil-works/pi-tui" .test-dist/node_modules/@earendil-works/pi-tui
ln -sfn "$P/node_modules/typebox" .test-dist/node_modules/typebox

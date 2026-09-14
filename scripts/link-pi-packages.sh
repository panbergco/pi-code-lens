#!/bin/bash
# The extension ships as TypeScript for pi to load, so testing its real wiring
# means compiling it and running it against pi's own packages. Find them from
# the installed binary rather than assuming an install layout.
set -e

# Find the package by SEARCHING, never by assuming `pi` is a symlink into it.
# It stopped being one: a local patched build replaced ~/.local/bin/pi with a
# wrapper script pointing at a checkout, so walking up from the binary landed at
# / and the whole suite refused to run. A test harness must not break because
# somebody changed how a binary is installed.
candidates=()
P=$(readlink -f "$(command -v pi 2>/dev/null)" 2>/dev/null || true)
while [ -n "$P" ] && [ "$P" != "/" ] && [ ! -f "$P/package.json" ]; do P=$(dirname "$P"); done
[ -n "$P" ] && [ "$P" != "/" ] && candidates+=("$P")
# A wrapper naming its own build, e.g. FORK=/path/to/dist/bundle/cli.js
if F=$(grep -ohE '/[^ "]*/packages/coding-agent' "$(command -v pi)" 2>/dev/null | head -1); then
  candidates+=("$F")
fi
candidates+=("/usr/lib/node_modules/@earendil-works/pi-coding-agent" \
             "$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent")

P=""
for c in "${candidates[@]}"; do
  [ -d "$c/node_modules" ] && { P="$c"; break; }
done
[ -n "$P" ] || { echo "pi packages not found (tried: ${candidates[*]})" >&2; exit 1; }
mkdir -p .test-dist/node_modules/@earendil-works
ln -sfn "$P" .test-dist/node_modules/@earendil-works/pi-coding-agent

# Resolve each dependency where it actually is. An npm install nests them under
# the package; a source checkout is a monorepo with siblings and a hoisted root.
# Assuming the first layout is what broke when the local build replaced the
# release — so look in all three, and say which one is missing rather than
# failing later with a bare module-not-found from inside a compiled test.
link_dep() {
  local name="$1" target="$2" p
  for p in "$P/node_modules/$name" "$P/../${name#@earendil-works/}" "$P/../../node_modules/$name"; do
    [ -e "$p" ] && { ln -sfn "$(readlink -f "$p")" ".test-dist/node_modules/$target"; return 0; }
  done
  echo "could not resolve $name near $P" >&2
  return 1
}
link_dep "@earendil-works/pi-tui" "@earendil-works/pi-tui"
link_dep "typebox" "typebox"

#!/usr/bin/env bash
# Render the README diagrams from docs/diagrams/*.mmd into light and dark PNGs.
# PNGs display everywhere, including the GitHub mobile app, which shows Mermaid blocks as code.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../docs/diagrams" && pwd)"
MMDC=(npx -y @mermaid-js/mermaid-cli@11.4.2)
for src in "$DIR"/*.mmd; do
  name="$(basename "$src" .mmd)"
  "${MMDC[@]}" -i "$src" -o "$DIR/$name-light.png" -t neutral -b '#ffffff' -s 2 -q
  "${MMDC[@]}" -i "$src" -o "$DIR/$name-dark.png" -t dark -b '#0d1117' -s 2 -q
  echo "rendered $name"
done

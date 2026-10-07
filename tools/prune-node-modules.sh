#!/usr/bin/env bash
# List (and optionally delete) node_modules for projects with no activity in N days.
#
# Staleness is judged by the PROJECT, never by node_modules itself:
#   1. last git commit date, when the project is a git repo
#   2. otherwise the newest mtime among its own source files (node_modules excluded)
#
# Dry run by default. Nothing is deleted without --delete.
#
#   bash prune-node-modules.sh                      # dry run, 90 days, ~/SOLIDITY
#   bash prune-node-modules.sh --days 180
#   bash prune-node-modules.sh --root ~/BLANCE
#   bash prune-node-modules.sh --delete             # actually remove
set -uo pipefail

ROOT="${HOME}/SOLIDITY"
DAYS=90
DELETE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root)   ROOT="$2"; shift 2 ;;
    --days)   DAYS="$2"; shift 2 ;;
    --delete) DELETE=1; shift ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

CUTOFF=$(( $(date +%s) - DAYS * 86400 ))
echo "Scanning $ROOT for node_modules whose project has been idle > ${DAYS} days"
[ "$DELETE" = "1" ] && echo "MODE: DELETE" || echo "MODE: dry run (pass --delete to remove)"
echo

total_kb=0
count=0
skipped=0

while IFS= read -r nm; do
  proj="$(dirname "$nm")"

  # Skip anything currently open/in use: a lockfile touched recently, or a live process cwd.
  if [ -d "$proj/.git" ]; then
    last=$(git -C "$proj" log -1 --format=%ct 2>/dev/null || echo 0)
  else
    last=0
  fi
  if [ "$last" = "0" ] || [ -z "$last" ]; then
    # newest mtime among the project's own files, ignoring node_modules and .git
    last=$(find "$proj" -maxdepth 3 \( -name node_modules -o -name .git \) -prune -o -type f -print 2>/dev/null \
           | head -400 | xargs stat -f %m 2>/dev/null | sort -rn | head -1)
  fi
  [ -z "$last" ] && last=0

  # Fail safe: if we could not date the project, treat it as ACTIVE and skip it.
  # (Otherwise a detection failure reads as "infinitely stale" and gets deleted.)
  if [ "$last" = "0" ]; then
    skipped=$((skipped+1))
    continue
  fi

  if [ "$last" -gt "$CUTOFF" ]; then
    skipped=$((skipped+1))
    continue
  fi

  kb=$(du -sk "$nm" 2>/dev/null | cut -f1)
  [ -z "$kb" ] && kb=0
  age_days=$(( ( $(date +%s) - last ) / 86400 ))
  mb=$(( kb / 1024 ))
  printf "%6s MB  idle %4sd  %s\n" "$mb" "$age_days" "${proj/#$HOME/\~}"
  total_kb=$((total_kb + kb))
  count=$((count+1))

  if [ "$DELETE" = "1" ]; then
    rm -rf "$nm"
  fi
done < <(find "$ROOT" -name node_modules -type d -prune 2>/dev/null | grep -v "/\.next/" | grep -v "/\.claude/worktrees/")

echo
printf "%s project(s), %s GB total. %s project(s) still active, left alone.\n" \
  "$count" "$(echo "scale=1; $total_kb/1048576" | bc)" "$skipped"
[ "$DELETE" = "1" ] && echo "Deleted. Restore any project with: pnpm install (or npm install) in its folder."

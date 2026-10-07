#!/usr/bin/env python3
"""One entry point for the toolkit. Each command owns its explicit stages/options."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = {
    'x': ['node', 'x-radar/radar.mjs'],
    'facebook': ['node', 'fb-radar/radar.mjs'],
    'jobs': ['node', 'ats-radar/poll.mjs'],
    'rank-jobs': ['node', 'ats-radar/rank.mjs'],
    'vc-jobs': ['node', 'ats-radar/getro.mjs'],
    'find-boards': ['node', 'ats-radar/find-slugs.mjs'],
    'buyers': ['node', 'buyer-signals/workable.mjs'],
    'buyer-feeds': ['node', 'buyer-signals/find-buyers.mjs'],
    'outreach': [sys.executable, 'buyer-signals/workflow.py'],
    'reddit-rank': [sys.executable, 'reddit-mining/find_leads.py'],
    'reddit-sellers': [sys.executable, 'reddit-mining/check_sellers.py'],
    'reddit-draft': [sys.executable, 'reddit-mining/draft_leads.py'],
    'prune': [sys.executable, 'tools/prune-data.py'],
}


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print('Usage: python3 tools/run.py COMMAND [options]\n\nCommands:\n  ' + '\n  '.join(COMMANDS))
        print('\nUse COMMAND --help for its options. No command sends outreach.')
        return 0
    command = COMMANDS.get(args[0])
    if command is None:
        print(f'Unknown command: {args[0]}', file=sys.stderr)
        return 2
    # Anchor executable paths, preserving the caller's cwd for their input paths.
    command = [command[0], str(ROOT / command[1])]
    return subprocess.run([*command, *args[1:]]).returncode


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compatibility entry point: runs `outreach draft` (use --help for inputs).

Drafting needs recorded review decisions (`outreach review --run RUN --decisions FILE`);
unreviewed prospects stay pending and accepted prospects without a verified inbox are held.
"""
import sys
from workflow import main

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--draft']
    raise SystemExit(main(['draft', *args]))

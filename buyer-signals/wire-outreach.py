#!/usr/bin/env python3
"""Compatibility entry point for the explicit buyer workflow; use --help for inputs."""
import sys
from workflow import main

if __name__ == '__main__':
    args = sys.argv[1:]
    stage = 'draft' if '--draft' in args else 'prepare'
    args = [a for a in args if a != '--draft']
    raise SystemExit(main([stage, *args]))

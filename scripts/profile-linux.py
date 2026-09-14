#!/usr/bin/env python3
"""Sample a running app and its descendants without reading app content or secrets.

CPU 100% means one fully occupied core. Summed RSS double-counts shared pages.
Short-lived processes between samples may be missed. This is not an FPS profiler.
"""
import argparse
import json
import os
from pathlib import Path
import time


def processes():
    result = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            line = path.read_text()
            fields = line[line.rfind(')') + 2:].split()
            result[int(path.parent.name)] = {
                'parent': int(fields[1]), 'ticks': int(fields[11]) + int(fields[12]),
                'started': int(fields[19]), 'rss': int(fields[21]) * os.sysconf('SC_PAGE_SIZE'),
            }
        except (OSError, ValueError, IndexError):
            pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pid', type=int)
    parser.add_argument('--seconds', type=float, default=10)
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error('--seconds must be positive')
    initial = processes()
    if args.pid not in initial:
        parser.error('PID is not running')
    identity = initial[args.pid]['started']
    start = time.monotonic()
    previous = {}
    ticks = 0
    peak_rss = 0
    samples = 0
    seen = set()
    while True:
        table = processes()
        if table.get(args.pid, {}).get('started') != identity:
            break
        selected = {args.pid}
        while True:
            expanded = selected | {pid for pid, row in table.items() if row['parent'] in selected}
            if expanded == selected:
                break
            selected = expanded
        current = {(pid, table[pid]['started']): table[pid]['ticks'] for pid in selected}
        if samples:
            ticks += sum(max(0, value - previous.get(key, value)) for key, value in current.items())
        previous = current
        seen.update(selected)
        peak_rss = max(peak_rss, sum(table[pid]['rss'] for pid in selected))
        samples += 1
        remaining = args.seconds - (time.monotonic() - start)
        if remaining <= 0:
            break
        time.sleep(min(0.25, remaining))
    elapsed = time.monotonic() - start
    print(json.dumps({
        'root_pid': args.pid, 'seconds': round(elapsed, 3), 'samples': samples,
        'cpu_percent_one_core': round(100 * ticks / os.sysconf('SC_CLK_TCK') / elapsed, 2),
        'peak_summed_rss_mib': round(peak_rss / 1024**2, 2), 'observed_pids': sorted(seen),
        'session_type': os.environ.get('XDG_SESSION_TYPE'),
        'note': 'Summed RSS double-counts shared pages; short-lived processes may be missed.',
    }, indent=2))


if __name__ == '__main__':
    main()

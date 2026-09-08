#!/usr/bin/env python
"""Run every test suite: Python ETL, JavaScript valuation, and the board UI.

    python run_tests.py

The UI suite needs a build to test against and jsdom to run it in; both skip
cleanly when absent rather than failing the run.
"""

from __future__ import print_function

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def run(label, command):
    print("\n" + "=" * 70)
    print(label)
    print("=" * 70)
    result = subprocess.call(command, cwd=ROOT)
    return result == 0


def main():
    ok = []

    ok.append(run("Python  --  ETL, name joining, source parsing",
                  [sys.executable, "-m", "unittest", "discover", "-s", "tests"]))

    node = None
    for candidate in ("node", "node.exe"):
        try:
            subprocess.check_output([candidate, "--version"], stderr=subprocess.STDOUT)
            node = candidate
            break
        except (OSError, subprocess.CalledProcessError):
            continue

    if node:
        ok.append(run("JavaScript  --  blending, replacement level, VORP, tiers",
                      [node, os.path.join("tests", "test_valuation.js")]))
        ok.append(run("Importer  --  parsing and mapping the real source files",
                      [node, os.path.join("tests", "test_importer.js")]))
        ok.append(run("Board UI  --  the built page, driven end to end",
                      [node, os.path.join("tests", "test_board_ui.js")]))
    else:
        print("\nNode not found -- skipped the JavaScript suites.")

    print("\n" + "=" * 70)
    print("ALL SUITES PASSED" if all(ok) else "SOME SUITES FAILED")
    print("=" * 70)
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())

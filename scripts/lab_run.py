"""Run a model-lab request: an allowlisted list of warehouse/modeling commands.

    python scripts/lab_run.py modeling/lab/request.json

The request is JSON:

    {"note": "why this run exists",
     "steps": [["warehouse", "player-box", "--catchup", "2600"],
               ["modeling", "build", "--market", "pa_outcome"]]}

Each step runs as `python -m <first> <rest...>`. Only the `warehouse` and
`modeling` packages are allowed, and `--promote` is refused anywhere: the lab
records runs, it never changes what production serves. A failing step is
reported and the rest still run (every run is recorded either way); the job
exits non-zero if any step failed so the red X is honest.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time

ALLOWED = {"warehouse", "modeling"}
FORBIDDEN_FLAGS = {"--promote"}


def validate(steps: list) -> list[list[str]]:
    out = []
    for i, step in enumerate(steps):
        if not isinstance(step, list) or not step or \
                not all(isinstance(a, str) for a in step):
            raise ValueError(f"step {i}: must be a non-empty list of strings")
        if step[0] not in ALLOWED:
            raise ValueError(f"step {i}: {step[0]!r} is not one of {sorted(ALLOWED)}")
        bad = FORBIDDEN_FLAGS & set(step)
        if bad:
            raise ValueError(f"step {i}: {sorted(bad)} is not allowed in the lab")
        out.append(step)
    return out


def main(path: str) -> int:
    with open(path, encoding="utf-8") as fh:
        req = json.load(fh)
    steps = validate(req.get("steps") or [])
    print(f"lab request: {req.get('note', '(no note)')}")
    failed = []
    for step in steps:
        print(f"::group::{' '.join(step)}", flush=True)
        t0 = time.time()
        rc = subprocess.call([sys.executable, "-m", *step])
        print(f"-- exit {rc} in {time.time() - t0:.0f}s", flush=True)
        print("::endgroup::", flush=True)
        if rc != 0:
            failed.append((" ".join(step), rc))
    for s, rc in failed:
        print(f"::error::step failed (exit {rc}): {s}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

"""Lab diagnostics: `python -m modeling research <name>`.

Each module here exposes `main(store, args)` and prints what it measured. They
exist because the warehouse lives in R2 and the people (and agents) building
models often cannot read it directly -- a probe run through the model-lab
workflow is how a number gets measured instead of assumed. Nothing here writes
anywhere.
"""

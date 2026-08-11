"""Offline ML workbench: build -> train -> validate -> record -> promote.

Deliberately separate from `backend/`. Nothing here runs in production; the
live scorer is supabase/functions/_shared/model.ts, which reads the params
this package fits and writes to model_params. The one hard contract between
the two is params JSON shape, pinned by tests/modeling/test_parity.py.
"""

__all__ = ["__version__"]
__version__ = "0.1.0"

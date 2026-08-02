"""Entry point for `python -m warehouse`. See warehouse.cli."""

import sys

from warehouse.cli import main

if __name__ == "__main__":
    sys.exit(main())

"""Entry point: python -m modeling <command>."""

import sys

from modeling.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

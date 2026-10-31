# RAGTruth viewer. Run `just` with no arguments to list the recipes.
#
# Needs Python 3 (and Node, for the JS tests); nothing to install.
# Use another interpreter with e.g.  PYTHON="uv run python" just run

python := env("PYTHON", "python3")

# List the recipes.
default:
    @just --list

# Serve at http://127.0.0.1:8765/. Extra args go to serve.py: --download (first use), --port N, --open.
run *args:
    {{ python }} serve.py {{ args }}

# Run every test suite.
test: test-py test-js

# Loader, index, search and HTTP tests.
test-py:
    {{ python }} -m unittest discover -s tests

# Span segmentation, evidence matching, selection logic and URL state.
test-js:
    node --test

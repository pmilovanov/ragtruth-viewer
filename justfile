# RAGTruth Viewer: a static site, no build step. Run `just` to list the recipes.

port := env("PORT", "8765")

# List the recipes.
default:
    @just --list

# Serve site/ at http://127.0.0.1:8765/ (any static file server will do).
run:
    python3 -m http.server {{ port }} --bind 127.0.0.1 --directory site

# Download the dataset into site/data/ for offline use; otherwise it comes from GitHub.
fetch-data:
    sh scripts/fetch-data.sh

# Run the tests (the real-dataset checks need `just fetch-data` first).
test:
    node --test

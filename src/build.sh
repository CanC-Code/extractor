#!/bin/bash
mkdir -p ../build

echo "Building SINGLE FILE version (parser.js contains Wasm)..."

emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_malloc","_free"]' \
    --no-entry

echo "Build done. Files:"
ls -la ../build/
#!/bin/bash
rm -rf ../build/*
mkdir -p ../build

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_unity_archive_offset","_deinterleave_mesh","_malloc","_free"]' \
    --no-entry \
    -s ENVIRONMENT=web,worker

echo "=== BUILD RESULT ==="
ls -la ../build/
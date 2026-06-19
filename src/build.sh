#!/bin/bash

mkdir -p ../build

echo "🚀 Starting Emscripten build..."

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_deinterleave_mesh","_malloc","_free"]' \
    --no-entry \
    -s SINGLE_FILE=0 \
    -s MODULARIZE=0

echo "=== Build Output Files ==="
ls -la ../build/

if [ -f ../build/parser.js ] && [ -f ../build/parser.wasm ]; then
    echo "🎉 SUCCESS: Both parser.js and parser.wasm generated!"
else
    echo "⚠️  WARNING: Missing one or more files!"
fi
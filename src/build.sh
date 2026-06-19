#!/bin/bash

mkdir -p ../build

echo "🚀 Building Unity Asset Parser..."

emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free","HEAPU8"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_deinterleave_mesh","_malloc","_free"]' \
    --no-entry

echo "✅ Build completed!"
ls -la ../build/
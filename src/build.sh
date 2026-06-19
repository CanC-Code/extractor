#!/bin/bash

mkdir -p ../build

echo "Building Unity Asset Parser with Emscripten..."

emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "malloc", "free", "HEAPU8"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive", "_process_chunk", "_deinterleave_mesh", "_malloc", "_free"]' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='Module' \
    --no-entry

echo "✅ Build complete! Files generated in ../build/"
echo "   - parser.js"
echo "   - parser.wasm"
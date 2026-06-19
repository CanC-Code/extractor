#!/bin/bash

# Ensure output directory exists
mkdir -p ../build

# Compile C++ to WebAssembly with Emscripten
# -s EXPORTED_RUNTIME_METHODS: Exposes memory management to JS
# -s ALLOW_MEMORY_GROWTH: Crucial for parsing large .apk files
emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "malloc", "free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive", "_malloc", "_free"]'

echo "Build complete. Wasm and JS bridge generated in /build"

#!/bin/bash

# Ensure output directory exists
mkdir -p ../build

# Compile C++ to WebAssembly with Emscripten
# Outputs parser.js, which will automatically load parser.wasm
emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=268435456 \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "malloc", "free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive", "_malloc", "_free", "_deinterleave_mesh", "_free_buffer"]'

echo "Build complete. parser.js and parser.wasm generated."

#!/bin/bash

# Ensure output directory exists
mkdir -p ../build

# Compile C++ to WebAssembly with Emscripten
# - EXPORTED_FUNCTIONS ensures dynamic allocations and memory freeing exist 
# - EXPORTED_RUNTIME_METHODS allows JS to interact string-pointers and arrays seamlessly
emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="['_malloc', '_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall', 'cwrap', 'getValue', 'setValue']"

echo "Build complete. Output generated in ../build/ directory."

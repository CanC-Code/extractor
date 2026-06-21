#!/bin/bash

# Ensure output directory exists
mkdir -p ../build

# Compile C++ to WebAssembly with Emscripten
emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "UTF8ToString"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive", "_deinterleave_mesh", "_interleaveMesh_to_obj", "_free_buffer", "_malloc", "_free"]' || {
        echo "Emscripten compilation failed";
        exit 1;
    }

echo "Build complete. Wasm and JS bridge generated in ../build/"

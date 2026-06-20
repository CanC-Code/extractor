#!/bin/bash
rm -rf ../build/*
mkdir -p ../build

echo "🚀 Building optimized Unity Parser..."

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s MAXIMUM_MEMORY=4294967296 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createUnityParser" \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","writeArrayToMemory"]' \
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_process_unity_archive","_deinterleave_mesh","_free_buffer"]'

echo "✅ Build complete!"

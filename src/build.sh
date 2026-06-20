#!/bin/bash

# Clean build directory
rm -rf ../build/*
mkdir -p ../build

echo "🚀 Building Unity Parser (Multi-file mode)..."

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","writeArrayToMemory"]' \
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_process_unity_archive","_free_buffer"]' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createUnityParser" \
    -s ENVIRONMENT="web,worker"

echo "✅ Build complete!"

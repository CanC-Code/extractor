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
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_unity_archive_offset","_deinterleave_mesh","_malloc","_free"]' \
    -s ENVIRONMENT=web,worker \
    --no-entry

echo "=== BUILD RESULT ==="
ls -la ../build/

if [ -f ../build/parser.js ] && [ -f ../build/parser.wasm ]; then
    echo "✅ SUCCESS! parser.js and parser.wasm generated."
else
    echo "❌ Build failed: Missing output files."
fi

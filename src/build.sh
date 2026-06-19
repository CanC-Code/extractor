#!/bin/bash

mkdir -p ../build

echo "🚀 Starting clean build..."

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=128MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_deinterleave_mesh","_malloc","_free"]' \
    --no-entry \
    -s SINGLE_FILE=0

echo "=== Build Output ==="
ls -la ../build/
echo "===================="

if [ -f ../build/parser.js ] && [ -f ../build/parser.wasm ]; then
    echo "✅ SUCCESS: Both files generated!"
else
    echo "❌ FAILED: Missing files!"
fi
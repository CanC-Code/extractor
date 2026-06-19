#!/bin/bash

# Clean previous build
rm -f ../build/parser.js ../build/parser.wasm ../build/Text.txt 2>/dev/null
mkdir -p ../build

echo "🚀 Starting clean Emscripten build..."

emcc asset_parser.cpp \
    -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_deinterleave_mesh","_malloc","_free"]' \
    --no-entry \
    -s SINGLE_FILE=0 \
    -s MODULARIZE=0 \
    -s ENVIRONMENT=web,worker

echo "=== Build Output ==="
ls -la ../build/

if [ -f ../build/parser.js ] && [ -f ../build/parser.wasm ]; then
    echo "🎉 SUCCESS: Both files generated!"
    echo "parser.js size: $(wc -c < ../build/parser.js) bytes"
else
    echo "❌ Failed to generate parser.js"
fi
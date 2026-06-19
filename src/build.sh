#!/bin/bash

# Ensure output directory exists
mkdir -p ../build

echo "🚀 Building Unity Asset Parser to WebAssembly..."

emcc asset_parser.cpp -o ../build/parser.js \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=256MB \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","malloc","free","HEAPU8"]' \
    -s EXPORTED_FUNCTIONS='["_process_unity_archive","_process_chunk","_deinterleave_mesh","_malloc","_free"]' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="Module" \
    --no-entry

# Verify output
echo "✅ Build finished. Checking files:"
ls -la ../build/

if [ -f ../build/parser.js ] && [ -f ../build/parser.wasm ]; then
    echo "🎉 Success! Both parser.js and parser.wasm were generated."
else
    echo "⚠️  Warning: Missing files detected!"
fi
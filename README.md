# extractor
web based extractor


# Local Asset Extractor & Web Viewer

A client-side only browser tool for extracting and viewing `.obj` meshes from `.apk` and Unity Data Asset Packs. Processing occurs entirely in local memory via WebAssembly; no data is transmitted to an external server.

## Architecture
- **Frontend:** HTML5, CSS3, Three.js (WebGL rendering)
- **File Processing:** Dedicated Web Worker `FileReader` streams
- **Binary Parsing:** C++ compiled to WebAssembly (Wasm)

## Local Development Setup
1. Ensure Emscripten SDK (`emsdk`) is installed and activated.
2. Run the build script to generate the Wasm module:
```bash
   cd src
   chmod +x build.sh
   ./build.sh


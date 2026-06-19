// js/worker.js

var Module = {
    // Emscripten inside a worker thinks its base directory is the worker's directory (/js/).
    // We must intercept the WASM request and strictly point it to the /build/ directory.
    locateFile: function(path, prefix) {
        if (path.endsWith('.wasm')) {
            // This reliably calculates the absolute URL to your build folder.
            // e.g., if worker is at https://canc-code.github.io/extractor/js/worker.js
            // it forces the fetch to https://canc-code.github.io/extractor/build/parser.wasm
            return new URL('../build/' + path, self.location.href).href;
        }
        return prefix + path;
    },
    onRuntimeInitialized: function() {
        self.postMessage({ type: 'READY' });
    },
    print: function(text) {
        self.postMessage({ type: 'LOG', logType: 'info', data: text });
    },
    printErr: function(text) {
        self.postMessage({ type: 'LOG', logType: 'error', data: text });
    }
};

self.Module = Module;

try {
    // Load the JS glue code
    importScripts('../build/parser.js'); 
} catch (error) {
    self.postMessage({ 
        type: 'ERROR', 
        command: 'init', 
        error: `Fatal import error. Ensure 'parser.js' exists in the build directory. Details: ${error.message}` 
    });
}

self.onmessage = function(event) {
    const { command, payload } = event.data;

    try {
        switch (command) {
            
            case 'PROCESS_FILE': {
                const file = payload.file;
                self.postMessage({ type: 'LOG', logType: 'info', data: `Worker loading ${file.name} into memory...` });

                // Read the file asynchronously in the background worker
                file.arrayBuffer().then(buffer => {
                    const uint8View = new Uint8Array(buffer);
                    const size = uint8View.length;

                    self.postMessage({ type: 'LOG', logType: 'info', data: `Allocating WASM heap for ${size} bytes...` });

                    // Allocate memory in WASM and copy
                    const dataPtr = Module._malloc(size);
                    Module.HEAPU8.set(uint8View, dataPtr);

                    // Call the C++ parser
                    Module.ccall(
                        'process_unity_archive', 
                        null,                    
                        ['number', 'number'],    
                        [dataPtr, size]          
                    );

                    // Free memory to prevent memory leaks and crashing
                    Module._free(dataPtr);
                    self.postMessage({ type: 'SUCCESS', command: 'PROCESS_FILE' });

                }).catch(error => {
                    self.postMessage({ type: 'ERROR', command: 'PROCESS_FILE', error: `Failed to read file buffer: ${error.message}` });
                });
                break;
            }

            case 'deinterleave_mesh': {
                const meshData = payload.meshData; 
                const numVertices = payload.numVertices;
                
                const bufferSize = meshData.length;
                const bufferPtr = Module._malloc(bufferSize);
                Module.HEAPU8.set(meshData, bufferPtr);

                const resultPtr = Module.ccall(
                    'deinterleave_mesh',
                    'number',             
                    ['number', 'number'],
                    [bufferPtr, numVertices]
                );

                const objFileString = Module.UTF8ToString(resultPtr);

                Module._free(bufferPtr);
                Module._free(resultPtr); 

                self.postMessage({ 
                    type: 'SUCCESS', 
                    command: command, 
                    result: objFileString 
                });
                break;
            }

            default:
                self.postMessage({ 
                    type: 'ERROR', 
                    command: command, 
                    error: 'Unknown command execution requested.' 
                });
        }
    } catch (error) {
        self.postMessage({ 
            type: 'ERROR', 
            command: command, 
            error: error.message || 'Unknown execution error within worker.' 
        });
    }
};

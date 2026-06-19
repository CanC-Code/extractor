// js/worker.js

var Module = {
    // Override the default WASM fetching to guarantee the correct absolute path
    // and provide human-readable errors if GitHub Pages returns a 404 HTML page.
    instantiateWasm: function(info, receiveInstance) {
        // Calculate the exact absolute URL based on the worker's location
        const wasmUrl = new URL('../build/parser.wasm', self.location.href).href;
        
        self.postMessage({ type: 'LOG', logType: 'info', data: `[WASM] Attempting to fetch binary from: ${wasmUrl}` });

        fetch(wasmUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} - File not found at ${wasmUrl}`);
                }
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('text/html')) {
                    throw new Error(`Server returned HTML instead of WebAssembly. The file is missing on the server at: ${wasmUrl}`);
                }
                return response.arrayBuffer();
            })
            .then(bytes => WebAssembly.instantiate(bytes, info))
            .then(result => {
                self.postMessage({ type: 'LOG', logType: 'success', data: '[WASM] Binary downloaded and compiled successfully.' });
                receiveInstance(result.instance);
            })
            .catch(err => {
                self.postMessage({ type: 'ERROR', command: 'init', error: err.message });
                self.postMessage({ type: 'LOG', logType: 'error', data: `[WASM FATAL] ${err.message}` });
            });

        // Return empty object to instruct Emscripten to wait for the async receiveInstance call
        return {}; 
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
    // Load the Emscripten JavaScript glue code
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

                    // Free memory to prevent leaks
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

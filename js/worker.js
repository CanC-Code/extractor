// js/worker.js

var Module = {
    locateFile: function(path, prefix) {
        if (path.endsWith('.wasm')) {
            return '../build/' + path;
        }
        return prefix + path;
    },
    print: function(text) {
        self.postMessage({ type: 'LOG', logType: 'info', data: text });
    },
    printErr: function(text) {
        self.postMessage({ type: 'LOG', logType: 'error', data: text });
    }
};

try {
    importScripts('../build/parser.js');
    if (typeof createUnityParser === 'function') {
        self.postMessage({ type: 'LOG', logType: 'info', data: 'Instantiating WASM Module...' });
        
        // Wait for the Promise to resolve BEFORE sending the READY signal.
        // This guarantees self.Module is the fully constructed instance with HEAPU8.
        createUnityParser(Module).then((instance) => {
            self.Module = instance;
            self.postMessage({ type: 'LOG', logType: 'info', data: '✅ WASM Runtime Initialized Successfully.' });
            self.postMessage({ type: 'READY' });
        }).catch((err) => {
            self.postMessage({ type: 'ERROR', command: 'init', error: `WASM Instantiation failed: ${err.message}` });
        });
    } else {
        self.Module = Module;
        self.postMessage({ type: 'READY' }); // Fallback for older emscripten behavior
    }
} catch (error) {
    self.postMessage({ type: 'ERROR', command: 'init', error: `Fatal import error: ${error.message}` });
}

self.onmessage = function(event) {
    const { command, payload } = event.data;

    if (!self.Module || !self.Module.HEAPU8) {
        self.postMessage({ type: 'ERROR', command: command, error: 'WASM Runtime or HEAPU8 not initialized yet. Please wait for the READY signal.' });
        return;
    }

    try {
        switch (command) {
            case 'PROCESS_FILE': {
                const file = payload.file;
                self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Loading ${file.name} into memory...` });

                file.arrayBuffer().then(buffer => {
                    const uint8View = new Uint8Array(buffer);
                    const size = uint8View.length;

                    self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Allocating WASM heap for ${size} bytes...` });
                    const dataPtr = self.Module._malloc(size);
                    
                    // Critical safety check for massive files
                    if (dataPtr === 0) {
                        throw new Error(`WASM out of memory: Failed to allocate ${size} bytes.`);
                    }

                    // HEAPU8 is now strictly guaranteed to exist
                    self.Module.HEAPU8.set(uint8View, dataPtr);

                    self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Executing process_unity_archive in C++...` });
                    const resultPtr = self.Module.ccall(
                        'process_unity_archive', 
                        'number',                    
                        ['number', 'number'],    
                        [dataPtr, size]          
                    );

                    const resultString = self.Module.UTF8ToString(resultPtr);
                    
                    self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Freeing allocated heap memory...` });
                    self.Module._free(dataPtr);
                    self.Module._free_buffer(resultPtr);

                    self.postMessage({ type: 'SUCCESS', command: 'PROCESS_FILE', result: resultString });
                }).catch(error => {
                    self.postMessage({ type: 'ERROR', command: 'PROCESS_FILE', error: `Failed to read file buffer: ${error.message}` });
                });
                break;
            }

            case 'deinterleave_mesh': {
                self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Preparing to deinterleave mesh...` });
                const meshData = new Uint8Array(payload.meshData);
                
                self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Allocating WASM heap for ${meshData.length} bytes...` });
                const bufferPtr = self.Module._malloc(meshData.length);
                
                if (bufferPtr === 0) {
                    throw new Error(`WASM out of memory: Failed to allocate ${meshData.length} bytes.`);
                }

                self.Module.HEAPU8.set(meshData, bufferPtr);

                self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Executing deinterleave_mesh in C++...` });
                const resultPtr = self.Module.ccall(
                    'deinterleave_mesh',
                    'number',             
                    ['number', 'number'],
                    [bufferPtr, payload.numVertices]
                );

                const objFileString = self.Module.UTF8ToString(resultPtr);

                self.postMessage({ type: 'LOG', logType: 'info', data: `[JS] Freeing allocated heap memory...` });
                self.Module._free(bufferPtr);
                self.Module._free_buffer(resultPtr); 

                self.postMessage({ type: 'SUCCESS', command: command, result: objFileString });
                break;
            }

            default:
                throw new Error('Unknown command execution requested.');
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', command: command, error: error.message });
    }
};

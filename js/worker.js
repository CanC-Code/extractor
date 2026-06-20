// js/worker.js

// 1. Initialize the Module with a factory pattern to handle asynchronous readiness
var Module = {
    locateFile: function(path, prefix) {
        if (path.endsWith('.wasm')) {
            return '../build/' + path;
        }
        return prefix + path;
    },
    // The Emscripten runtime will call this once the WASM binary is loaded and ready
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

// 2. Load the glue code. 
// We rely on the fact that parser.js expects 'Module' to exist globally.
try {
    importScripts('../build/parser.js');
    // If using MODULARIZE=1 in emcc, we need to invoke the constructor
    if (typeof createUnityParser === 'function') {
        createUnityParser(Module).then((instance) => {
            self.Module = instance;
        });
    } else {
        self.Module = Module;
    }
} catch (error) {
    self.postMessage({ 
        type: 'ERROR', 
        command: 'init', 
        error: `Fatal import error. Could not load '../build/parser.js'. Details: ${error.message}` 
    });
}

// 3. Worker Communication Logic
self.onmessage = function(event) {
    const { command, payload } = event.data;

    // Safety check: Ensure Module is actually loaded before processing
    if (!self.Module) {
        self.postMessage({ type: 'ERROR', command: command, error: 'WASM Runtime not initialized yet.' });
        return;
    }

    try {
        switch (command) {
            case 'PROCESS_FILE': {
                const file = payload.file;
                file.arrayBuffer().then(buffer => {
                    const uint8View = new Uint8Array(buffer);
                    const size = uint8View.length;

                    const dataPtr = self.Module._malloc(size);
                    self.Module.HEAPU8.set(uint8View, dataPtr);

                    // Call C function and get result (Assuming it returns a char* string)
                    const resultPtr = self.Module.ccall(
                        'process_unity_archive', 
                        'number',                    
                        ['number', 'number'],    
                        [dataPtr, size]          
                    );

                    const resultString = self.Module.UTF8ToString(resultPtr);
                    
                    // Cleanup memory
                    self.Module._free(dataPtr);
                    self.Module._free_buffer(resultPtr); // Ensure this matches your CPP exported function

                    self.postMessage({ type: 'SUCCESS', command: 'PROCESS_FILE', result: resultString });
                });
                break;
            }

            case 'deinterleave_mesh': {
                const meshData = new Uint8Array(payload.meshData);
                const bufferPtr = self.Module._malloc(meshData.length);
                self.Module.HEAPU8.set(meshData, bufferPtr);

                const resultPtr = self.Module.ccall(
                    'deinterleave_mesh',
                    'number',             
                    ['number', 'number'],
                    [bufferPtr, payload.numVertices]
                );

                const objFileString = self.Module.UTF8ToString(resultPtr);

                self.Module._free(bufferPtr);
                self.Module._free_buffer(resultPtr); 

                self.postMessage({ type: 'SUCCESS', command: command, result: objFileString });
                break;
            }

            default:
                throw new Error('Unknown command.');
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', command: command, error: error.message });
    }
};

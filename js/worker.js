// js/worker.js

// 1. Define the Emscripten Module configuration safely using var
var Module = {
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

// Ensure self.Module is also set for standard Web Worker context hooks
self.Module = Module;

// 2. Import the Emscripten-generated JavaScript file safely
try {
    // NOTE: If your parser.js is located in the root build directory instead of js/, 
    // you must change this path to: importScripts('../build/parser.js');
    importScripts('parser.js'); 
    
    // Fallback hook: If SINGLE_FILE initialized synchronously and bypassed the async hook
    if (Module.calledRun) {
        self.postMessage({ type: 'READY' });
    }
} catch (error) {
    self.postMessage({ 
        type: 'ERROR', 
        command: 'init', 
        error: `Fatal import error. Ensure 'parser.js' is in the same directory as worker.js. Details: ${error.message}` 
    });
}

// 3. Listen for commands from the Main Thread
self.onmessage = function(event) {
    const { command, payload } = event.data;

    try {
        switch (command) {
            case 'process_unity_archive': {
                const fileData = payload.fileData; 
                const size = fileData.length;
                
                const dataPtr = Module._malloc(size);
                Module.HEAPU8.set(fileData, dataPtr);

                Module.ccall(
                    'process_unity_archive', 
                    null,                    
                    ['number', 'number'],    
                    [dataPtr, size]          
                );

                Module._free(dataPtr);
                self.postMessage({ type: 'SUCCESS', command: command });
                break;
            }

            case 'process_unity_archive_offset': {
                const bundleOffset = payload.bundleOffset;
                const dataStart = payload.dataStart;
                const blocksInfo = payload.blocksInfo;

                Module.ccall(
                    'process_unity_archive_offset',
                    null,
                    ['number', 'number', 'number'], 
                    [bundleOffset, dataStart, blocksInfo] 
                );

                self.postMessage({ type: 'SUCCESS', command: command });
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

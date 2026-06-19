// worker.js

// 1. Define the Emscripten Module configuration BEFORE importing the glue code
self.Module = {
    // Fired when the WebAssembly module has been downloaded and instantiated
    onRuntimeInitialized: function() {
        console.log('[WASM Worker] Runtime initialized.');
        postMessage({ type: 'READY' });
    },
    // Reroute C++ std::cout to the worker's console
    print: function(text) {
        console.log('[C++ stdout]', text);
    },
    // Reroute C++ std::cerr to the worker's console
    printErr: function(text) {
        console.error('[C++ stderr]', text);
    }
};

// 2. Import the Emscripten-generated JavaScript file
// NOTE: Change 'asset_parser.js' to match your compiler output filename
importScripts('asset_parser.js');

// 3. Listen for commands from the Main Thread
self.onmessage = function(event) {
    const { command, payload } = event.data;

    try {
        switch (command) {
            
            // -------------------------------------------------------------
            // Command: process_unity_archive
            // -------------------------------------------------------------
            case 'process_unity_archive': {
                const fileData = payload.fileData; // Expected: Uint8Array
                const size = fileData.length;
                
                // Allocate memory inside WASM heap
                const dataPtr = Module._malloc(size);
                
                // Copy JS array data into WASM heap
                Module.HEAPU8.set(fileData, dataPtr);

                // Call C++ function
                Module.ccall(
                    'process_unity_archive', 
                    null,                    
                    ['number', 'number'],    
                    [dataPtr, size]          
                );

                // Prevent memory leaks
                Module._free(dataPtr);
                
                postMessage({ type: 'SUCCESS', command: command });
                break;
            }

            // -------------------------------------------------------------
            // Command: process_unity_archive_offset
            // -------------------------------------------------------------
            case 'process_unity_archive_offset': {
                const bundleOffset = payload.bundleOffset;
                const dataStart = payload.dataStart;
                const blocksInfo = payload.blocksInfo;

                // Call C++ function directly with numeric arguments
                Module.ccall(
                    'process_unity_archive_offset',
                    null,
                    ['number', 'number', 'number'], 
                    [bundleOffset, dataStart, blocksInfo] 
                );

                postMessage({ type: 'SUCCESS', command: command });
                break;
            }

            // -------------------------------------------------------------
            // Command: deinterleave_mesh
            // -------------------------------------------------------------
            case 'deinterleave_mesh': {
                const meshData = payload.meshData; // Expected: Uint8Array
                const numVertices = payload.numVertices;
                
                const bufferSize = meshData.length;
                
                // Allocate input buffer
                const bufferPtr = Module._malloc(bufferSize);
                Module.HEAPU8.set(meshData, bufferPtr);

                // Execute C++ function, returning the char* pointer location
                const resultPtr = Module.ccall(
                    'deinterleave_mesh',
                    'number',             
                    ['number', 'number'],
                    [bufferPtr, numVertices]
                );

                // Extract the resulting string from the WASM heap
                const objFileString = Module.UTF8ToString(resultPtr);

                // Free BOTH the input array buffer and the dynamically allocated char* Module._free(bufferPtr);
                Module._free(resultPtr); 

                // Send the generated .obj string back to the main thread
                postMessage({ 
                    type: 'SUCCESS', 
                    command: command, 
                    result: objFileString 
                });
                break;
            }

            // -------------------------------------------------------------
            // Fallback Handling
            // -------------------------------------------------------------
            default:
                console.warn(`[WASM Worker] Unknown command received: ${command}`);
                postMessage({ 
                    type: 'ERROR', 
                    command: command, 
                    error: 'Unknown command execution requested.' 
                });
        }
    } catch (error) {
        console.error(`[WASM Worker] Error executing ${command}:`, error);
        postMessage({ 
            type: 'ERROR', 
            command: command, 
            error: error.message || 'Unknown execution error within worker.' 
        });
    }
};

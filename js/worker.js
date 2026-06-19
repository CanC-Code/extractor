// js/worker.js
importScripts('../build/parser.js');

let wasmReady = false;

Module.onRuntimeInitialized = () => {
    wasmReady = true;
    postMessage({ type: 'LOG', data: '✅ WASM Parser Engine Ready', logType: 'success' });
};

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 8 * 1024 * 1024; // 8MB chunks
        let offset = 0;

        postMessage({ 
            type: 'LOG', 
            data: `Scanning ${file.name}...`, 
            logType: 'system' 
        });

        // Ensure WASM is ready before we begin sending data to it
        if (!wasmReady) {
            postMessage({ type: 'LOG', data: '⏳ Waiting for WASM engine...', logType: 'warning' });
            while (!wasmReady) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        const readNextChunk = () => {
            if (offset >= file.size) {
                postMessage({ type: 'LOG', data: '✅ Scan Complete', logType: 'success' });
                postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const u8 = new Uint8Array(evt.target.result);
                const percent = Math.floor(((offset + chunkSize) / file.size) * 100);
                postMessage({ type: 'PROGRESS', data: Math.min(100, percent) });

                // === UnityFS Bundle Detection ===
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && 
                        u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {

                        const absOffset = offset + i;
                        postMessage({ 
                            type: 'LOG', 
                            data: `[BUNDLE] Found UnityFS at offset 0x${absOffset.toString(16).toUpperCase()}`,
                            logType: 'success' 
                        });
                    }
                }

                // === Improved Asset Name Extraction ===
                extractAssetNames(u8, offset);

                // === WASM Model Processing ===
                // Allocate memory inside the WASM heap
                const ptr = Module._malloc(u8.length * u8.BYTES_PER_ELEMENT);
                // Copy the Javascript Uint8Array into the WASM heap
                Module.HEAPU8.set(u8, ptr);

                try {
                    // Call the C++ parser. 
                    // NOTE: Uncomment and update 'parse_mesh_data' to match your actual C++ export name.
                    
                    /*
                    const resultPtr = Module.ccall(
                        'parse_mesh_data',              // C++ function name
                        'number',                       // Return type (pointer to OBJ string)
                        ['number', 'number', 'number'], // Argument types
                        [ptr, u8.length, offset]        // Arguments: buffer pointer, chunk length, file offset
                    );

                    if (resultPtr !== 0) {
                        const objData = Module.UTF8ToString(resultPtr);
                        postMessage({
                            type: 'MODEL_FOUND',
                            data: {
                                obj: objData,
                                offset: offset
                            }
                        });
                        Module._free(resultPtr); // Free the returned string memory allocated by C++
                    }
                    */
                    
                } catch (err) {
                    console.error("WASM Processing Error:", err);
                } finally {
                    // CRITICAL: Always free the input buffer memory to prevent memory leaks
                    Module._free(ptr);
                }

                offset += chunkSize;
                setTimeout(readNextChunk, 5);
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

function extractAssetNames(u8, chunkOffset) {
    let str = "";
    let found = 0;

    for (let i = 0; i < u8.length; i++) {
        const code = u8[i];

        if (code >= 32 && code <= 126) {
            str += String.fromCharCode(code);
        } else {
            if (str.length > 10) {
                const lower = str.toLowerCase();

                if (
                    lower.includes('.mesh') || 
                    lower.includes('.tex') || 
                    lower.includes('.png') || 
                    lower.includes('.jpg') || 
                    lower.includes('.mat') || 
                    lower.includes('.asset') || 
                    lower.includes('.prefab') ||
                    str.startsWith('CAB-') ||
                    (str.includes('.') && str.length < 80)
                ) {
                    postMessage({
                        type: 'ASSET_FOUND_META',
                        data: {
                            name: str.trim(),
                            offset: chunkOffset + i - str.length
                        }
                    });
                    found++;
                    if (found > 25) break; // prevent spam
                }
            }
            str = "";
        }
    }
}

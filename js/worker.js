// js/worker.js
let wasmModule = null;

// Initialize WASM Module
importScripts('../build/parser.js'); 
Module.onRuntimeInitialized = () => {
    wasmModule = Module;
    postMessage({ type: 'LOG', data: 'WASM C++ Engine Initialized', logType: 'success' });
};

function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

// C++ callback when a node is extracted from a UnityFS bundle
self.onFileExtracted = function(fileName, bufferPtr, size) {
    if (!wasmModule) return;
    
    // Copy data from WASM heap to a JS ArrayBuffer
    const heapBytes = new Uint8Array(wasmModule.HEAPU8.buffer, bufferPtr, size);
    const resultBuffer = new Uint8Array(size);
    resultBuffer.set(heapBytes);

    const isModel = /\.(mesh|fbx|obj|prefab)$/i.test(fileName);

    postMessage({
        type: 'ASSET_EXTRACTED',
        data: {
            name: fileName,
            buffer: resultBuffer.buffer, // Send the extracted inner file
            isModel: isModel
        }
    }, [resultBuffer.buffer]); 
};

onmessage = async function(e) {
    const { type, file, assetMeta, isContainer } = e.data;

    if (type === 'PROCESS_FILE') {
        log(`Worker initiated binary scan for ${file.name}`);
        
        try {
            const buffer = await file.arrayBuffer();
            const arr = new Uint8Array(buffer);
            const decoder = new TextDecoder('utf-8');
            let foundCount = 0;

            for (let i = 0; i < arr.length - 30; i++) {
                if (arr[i] === 0x50 && arr[i+1] === 0x4B && arr[i+2] === 0x03 && arr[i+3] === 0x04) {
                    const view = new DataView(buffer, i, 30);
                    const flags = view.getUint16(6, true);
                    const compSize = view.getUint32(18, true);
                    const nameLen = view.getUint16(26, true);
                    const extraLen = view.getUint16(28, true);
                    
                    const hasDataDescriptor = (flags & 0x0008) !== 0; 
                    
                    if (i + 30 + nameLen <= arr.length) {
                        const nameBytes = new Uint8Array(buffer, i + 30, nameLen);
                        let name = decoder.decode(nameBytes).replace(/\0/g, '').trim();
                        const dataOffset = i + 30 + nameLen + extraLen;

                        if (!name.endsWith('/')) {
                            postMessage({
                                type: 'ASSET_FOUND_META',
                                data: { name, offset: dataOffset, size: compSize }
                            });
                            foundCount++;
                        }
                    }
                    if (!hasDataDescriptor && compSize > 0) i += (30 + nameLen + extraLen + compSize - 1);
                }
            }
            log(`Scan complete. Found ${foundCount} files.`, "success");
        } catch (err) {
            log(`File reading error: ${err.message}`, 'error');
        }
    } 
    else if (type === 'EXTRACT_ASSET') {
        const { offset, size, name } = assetMeta;
        
        try {
            const chunk = file.slice(offset, offset + size);
            const arrayBuffer = await chunk.arrayBuffer();

            if (isContainer && wasmModule) {
                log(`Sending ${name} to C++ Engine for unpacking...`, 'info');
                
                // Allocate memory in WASM heap
                const ptr = wasmModule._malloc(arrayBuffer.byteLength);
                const heapArray = new Uint8Array(wasmModule.HEAPU8.buffer, ptr, arrayBuffer.byteLength);
                heapArray.set(new Uint8Array(arrayBuffer));
                
                // Call the C++ process function
                wasmModule.ccall('process_unity_archive', null, ['number', 'number'], [ptr, arrayBuffer.byteLength]);
                
                wasmModule._free(ptr);
            } else {
                // Return standard file directly
                postMessage({
                    type: 'ASSET_EXTRACTED',
                    data: { name: name, buffer: arrayBuffer, isContainer: false }
                }, [arrayBuffer]); 
            }
        } catch (err) {
            log(`Extraction failed for ${name}: ${err.message}`, 'error');
        }
    }
};

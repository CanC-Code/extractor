// js/worker.js
let wasmModule = null;

// Helper to push logs to the UI
function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

function updateStatus(state, message) {
    postMessage({ type: 'STATUS', data: { state, message } });
}

// Global error catcher for the worker thread
self.onerror = function(message, source, lineno, colno, error) {
    log(`Worker Error: ${message} at line ${lineno}`, 'error');
    updateStatus('error', 'WORKER ERROR');
    return true; 
};

// Initialize WASM Parser safely
try {
    log("Attempting to load WASM engine...", "info");
    importScripts('../build/parser.js'); 
    Module.onRuntimeInitialized = () => {
        wasmModule = Module;
        log('WASM Engine Initialized & Ready', 'success');
    };
} catch (e) {
    log(`Failed to load parser.js: ${e.message}. Is the path correct?`, 'error');
    updateStatus('error', 'WASM LOAD FAIL');
}

self.onFileExtracted = function(fileName, bufferPtr, size, isSerializedContainer) {
    if (!wasmModule) return;
    
    const heapBytes = new Uint8Array(wasmModule.HEAPU8.buffer, bufferPtr, size);
    const resultBuffer = new Uint8Array(size);
    resultBuffer.set(heapBytes);

    postMessage({
        type: 'ASSET_EXTRACTED',
        data: {
            name: fileName,
            buffer: resultBuffer.buffer, 
            isContainer: isSerializedContainer
        }
    }, [resultBuffer.buffer]); 
};

onmessage = async function(e) {
    const { type, file, assetMeta, isContainer } = e.data;

    if (type === 'PROCESS_FILE') {
        log(`Initiating byte-level scan for ${file.name}`);
        updateStatus('working', 'SCANNING ARCHIVE...');
        
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
            log(`Scan Complete. Found ${foundCount} valid files.`, "success");
            updateStatus('idle', 'SYSTEM IDLE');
        } catch (err) {
            log(`File IO error: ${err.message}`, 'error');
            updateStatus('error', 'SCAN FAILED');
        }
    } 
    else if (type === 'EXTRACT_ASSET') {
        const { offset, size, name } = assetMeta;
        updateStatus('extracting', 'EXTRACTING BUFFER...');
        
        try {
            const chunk = file.slice(offset, offset + size);
            const arrayBuffer = await chunk.arrayBuffer();

            if (isContainer) {
                if (!wasmModule) {
                    log("Cannot parse bundle: WASM module is not loaded.", "error");
                    updateStatus('error', 'WASM OFFLINE');
                    return;
                }
                
                log(`Sending ${name} payload to WASM Engine...`, 'info');
                updateStatus('working', 'WASM UNPACKING...');
                
                const ptr = wasmModule._malloc(arrayBuffer.byteLength);
                const heapArray = new Uint8Array(wasmModule.HEAPU8.buffer, ptr, arrayBuffer.byteLength);
                heapArray.set(new Uint8Array(arrayBuffer));
                
                wasmModule.ccall('process_unity_archive', null, ['number', 'number'], [ptr, arrayBuffer.byteLength]);
                wasmModule._free(ptr);
                
                updateStatus('idle', 'SYSTEM IDLE');
            } else {
                postMessage({
                    type: 'ASSET_EXTRACTED',
                    data: { name: name, buffer: arrayBuffer, isContainer: false }
                }, [arrayBuffer]); 
            }
        } catch (err) {
            log(`Extraction failed for ${name}: ${err.message}`, 'error');
            updateStatus('error', 'EXTRACTION FAILED');
        }
    }
};

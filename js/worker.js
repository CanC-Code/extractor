// js/worker.js
let wasmModule = null;

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

// Configure Emscripten Module BEFORE loading the script
self.Module = {
    // Explicitly tell Emscripten where to find the .wasm file
    locateFile: function(path, scriptDirectory) {
        if (path.endsWith('.wasm')) {
            return '../build/' + path;
        }
        return scriptDirectory + path;
    },
    onRuntimeInitialized: function() {
        wasmModule = self.Module;
        log('WASM Engine Initialized & Ready', 'success');
        updateStatus('idle', 'SYSTEM IDLE');
    }
};

// Safely initialize WASM Parser with path fallbacks
try {
    log("Attempting to load WASM engine...", "info");
    updateStatus('working', 'BOOTING WASM...');
    
    // Fallback paths to handle different hosting environments and GitHub Pages structures
    const paths = [
        '../build/parser.js', 
        './build/parser.js', 
        '../../build/parser.js', 
        '/build/parser.js'
    ];
    
    let loaded = false;
    for (let p of paths) {
        try {
            importScripts(p);
            loaded = true;
            log(`Successfully loaded parser script from: ${p}`, 'info');
            break;
        } catch (e) {
            // Silently try the next path
        }
    }
    
    if (!loaded) {
        throw new Error("Failed to load parser.js from all known paths. Ensure you are running on a local web server (http://localhost), NOT the file:// protocol.");
    }
    
} catch (e) {
    log(`CRITICAL: ${e.message}`, 'error');
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

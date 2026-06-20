// js/worker.js
let wasmModule = null;

function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

function updateStatus(state, message) {
    postMessage({ type: 'STATUS', data: { state, message } });
}

// Global error catcher
self.onerror = function(message, source, lineno, colno, error) {
    log(`Worker Error: ${message}`, 'error');
    return true; 
};

// Force WASM binary to load from the absolute /build/ path
self.Module = {
    locateFile: function(path, prefix) {
        if (path.endsWith('.wasm')) return '/build/' + path;
        return prefix + path;
    },
    onRuntimeInitialized: function() {
        wasmModule = self.Module;
        log('WASM Engine Ready', 'success');
    }
};

// Load parser.js using absolute path from root
try {
    importScripts('/build/parser.js');
} catch (e) {
    log("Failed to load /build/parser.js. Ensure your server serves /build/ directory.", "error");
}

self.onFileExtracted = function(fileName, bufferPtr, size, isSerializedContainer) {
    if (!wasmModule) return;
    const heapBytes = new Uint8Array(wasmModule.HEAPU8.buffer, bufferPtr, size);
    const resultBuffer = new Uint8Array(size);
    resultBuffer.set(heapBytes);
    postMessage({ type: 'ASSET_EXTRACTED', data: { name: fileName, buffer: resultBuffer.buffer, isContainer: isSerializedContainer }}, [resultBuffer.buffer]); 
};

onmessage = async function(e) {
    const { type, file, assetMeta, isContainer } = e.data;
    if (type === 'PROCESS_FILE') {
        try {
            const buffer = await file.arrayBuffer();
            const arr = new Uint8Array(buffer);
            const decoder = new TextDecoder('utf-8');
            let foundCount = 0;
            for (let i = 0; i < arr.length - 30; i++) {
                if (arr[i] === 0x50 && arr[i+1] === 0x4B && arr[i+2] === 0x03 && arr[i+3] === 0x04) {
                    const view = new DataView(buffer, i, 30);
                    const compSize = view.getUint32(18, true);
                    const nameLen = view.getUint16(26, true);
                    const extraLen = view.getUint16(28, true);
                    if (i + 30 + nameLen <= arr.length) {
                        let name = decoder.decode(new Uint8Array(buffer, i + 30, nameLen)).replace(/\0/g, '').trim();
                        if (!name.endsWith('/')) {
                            postMessage({ type: 'ASSET_FOUND_META', data: { name, offset: i + 30 + nameLen + extraLen, size: compSize }});
                            foundCount++;
                        }
                    }
                    if (compSize > 0) i += (30 + nameLen + extraLen + compSize - 1);
                }
            }
            log(`Scan Complete: ${foundCount} files`, "success");
        } catch (err) { log(`IO Error: ${err.message}`, 'error'); }
    } else if (type === 'EXTRACT_ASSET') {
        try {
            const chunk = file.slice(assetMeta.offset, assetMeta.offset + assetMeta.size);
            const arrayBuffer = await chunk.arrayBuffer();
            if (isContainer && wasmModule) {
                const ptr = wasmModule._malloc(arrayBuffer.byteLength);
                new Uint8Array(wasmModule.HEAPU8.buffer, ptr, arrayBuffer.byteLength).set(new Uint8Array(arrayBuffer));
                wasmModule.ccall('process_unity_archive', null, ['number', 'number'], [ptr, arrayBuffer.byteLength]);
                wasmModule._free(ptr);
            } else {
                postMessage({ type: 'ASSET_EXTRACTED', data: { name: assetMeta.name, buffer: arrayBuffer, isContainer: false }}, [arrayBuffer]); 
            }
        } catch (err) { log(`Extraction failed: ${err.message}`, 'error'); }
    }
};

// js/worker.js
importScripts('../build/parser.js');

let wasmReady = false;

Module.onRuntimeInitialized = () => {
    wasmReady = true;
    console.log("✅ WASM Parser Loaded");
    postMessage({ type: 'LOG', data: 'WASM Engine Ready', logType: 'success' });
};

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 8 * 1024 * 1024; // 8MB chunks
        let offset = 0;

        postMessage({ 
            type: 'LOG', 
            data: `Processing ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`,
            logType: 'system' 
        });

        const processBundle = (data) => {
            if (!wasmReady) return;
            try {
                // For SINGLE_FILE mode we use ccall
                Module.ccall('process_unity_archive', 'void', ['array', 'number'], [data, data.length]);
            } catch (err) {
                postMessage({ type: 'LOG', data: 'WASM call error: ' + err.message, logType: 'error' });
            }
        };

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
                const percent = Math.floor((offset / file.size) * 100);
                
                postMessage({ type: 'PROGRESS', data: percent });

                // Scan for UnityFS
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && 
                        u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        
                        const absOffset = offset + i;
                        postMessage({ 
                            type: 'LOG', 
                            data: `[BUNDLE] Found UnityFS at offset 0x${absOffset.toString(16).toUpperCase()}`,
                            logType: 'success' 
                        });

                        // Send chunk to WASM
                        const chunk = u8.slice(i, Math.min(i + 1024, u8.length));
                        processBundle(chunk);
                    }
                }

                extractAssetNames(u8, offset);

                offset += chunkSize;
                setTimeout(readNextChunk, 10);
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

function extractAssetNames(u8, chunkOffset) {
    let str = "";
    for (let i = 0; i < u8.length; i++) {
        const c = u8[i];
        if (c >= 32 && c <= 126) {
            str += String.fromCharCode(c);
        } else {
            if (str.length > 8) {
                const lower = str.toLowerCase();
                if (lower.includes('.mesh') || lower.includes('.mat') || 
                    lower.includes('.tex') || lower.includes('.png') || 
                    lower.includes('.asset') || str.startsWith('CAB-')) {
                    
                    postMessage({
                        type: 'ASSET_FOUND',
                        data: { name: str.substring(0, 100), offset: chunkOffset + i - str.length }
                    });
                }
            }
            str = "";
        }
    }
}
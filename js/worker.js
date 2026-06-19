// js/worker.js
importScripts('../build/parser.js');

let wasmReady = false;

if (typeof Module !== 'undefined') {
    Module.onRuntimeInitialized = () => {
        wasmReady = true;
        console.log("✅ WASM Parser Ready");
        postMessage({ type: 'LOG', data: 'WASM Engine initialized', logType: 'success' });
    };
}

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024;
        let offset = 0;

        postMessage({ 
            type: 'LOG', 
            data: `Scanning ${file.name}...`, 
            logType: 'system' 
        });

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

                // === UNITYFS BUNDLE DETECTION ===
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && 
                        u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        
                        const absOffset = offset + i;
                        postMessage({ 
                            type: 'LOG', 
                            data: `[BUNDLE] Found UnityFS at offset 0x${absOffset.toString(16).toUpperCase()}`,
                            logType: 'success' 
                        });

                        // Try to send to WASM
                        if (wasmReady) {
                            try {
                                const chunk = u8.slice(Math.max(0, i-64), Math.min(i + 512, u8.length));
                                Module.ccall('process_unity_archive', 'void', ['array', 'number'], [chunk, chunk.length]);
                            } catch (err) {}
                        }
                    }
                }

                // === IMPROVED ASSET NAME EXTRACTION ===
                extractAssets(u8, offset);

                offset += chunkSize;
                setTimeout(readNextChunk, 5);
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

function extractAssets(u8, chunkOffset) {
    let str = "";
    for (let i = 0; i < u8.length; i++) {
        const code = u8[i];

        if (code >= 32 && code <= 126) {
            str += String.fromCharCode(code);
        } else {
            if (str.length > 10) {
                const lower = str.toLowerCase();
                if (lower.includes('.mesh') || lower.includes('.tex') || 
                    lower.includes('.png') || lower.includes('.mat') || 
                    lower.includes('.asset') || lower.includes('.prefab') ||
                    str.startsWith('CAB-') || str.includes('Assets/')) {

                    postMessage({
                        type: 'ASSET_FOUND_META',
                        data: {
                            name: str.trim().substring(0, 120),
                            offset: chunkOffset + i - str.length
                        }
                    });
                }
            }
            str = "";
        }
    }
}
let wasmEngineReady = false;

// Configure the Emscripten Module environment
var Module = {
    onRuntimeInitialized: function() {
        wasmEngineReady = true;
        postMessage({ type: 'LOG', data: 'WASM C++ Engine Initialized & Ready.', logType: 'success' });
        postMessage({ type: 'WASM_READY' }); 
    },
    print: function(text) {
        postMessage({ type: 'LOG', data: `[C++] ${text}`, logType: 'system' });
    },
    printErr: function(text) {
        postMessage({ type: 'LOG', data: `[C++ ERROR] ${text}`, logType: 'error' });
    }
};

// Attempt to load the WASM glue script securely
try {
    importScripts('../build/parser.js');
} catch (error) {
    postMessage({ 
        type: 'LOG', 
        data: `CRITICAL: Failed to load parser.js. Ensure it exists in the /build/ directory. Extractor will run in scan-only mode. Error: ${error.message}`, 
        logType: 'error' 
    });
}

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024; // 10MB chunks
        let offset = 0;

        self.postMessage({ type: 'LOG', data: `Beginning chunked deep scan...`, logType: 'system' });
        self.postMessage({ type: 'PROGRESS', data: 0 });

        const readNextChunk = () => {
            if (offset >= file.size) {
                self.postMessage({ type: 'LOG', data: `Scan complete.`, logType: 'success' });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const buffer = evt.target.result;
                const view = new DataView(buffer);
                const u8 = new Uint8Array(buffer);
                
                self.postMessage({ type: 'PROGRESS', data: ((offset / file.size) * 100).toFixed(1) });

                // Scan for UnityFS headers
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        const absoluteOffset = offset + i;
                        try {
                            parseUnityFSHeader(view, i, absoluteOffset, file.size, u8);
                        } catch (err) {} 
                    }
                }

                extractRealAssetNames(u8, offset);
                offset += chunkSize;
                setTimeout(readNextChunk, 10); 
            };

            reader.onerror = function() {
                self.postMessage({ type: 'LOG', data: `Buffer read error at offset ${offset}`, logType: 'error' });
            };
            reader.readAsArrayBuffer(slice);
        };
        readNextChunk(); 
    }
};

function parseUnityFSHeader(view, localOffset, absoluteOffset, totalFileSize, u8Array) {
    let pos = localOffset;

    function readString(maxLength = 64) {
        let str = '';
        let start = pos;
        while (pos < view.byteLength) {
            if (pos - start > maxLength) throw new Error("String exceeded max length.");
            let char = view.getUint8(pos++);
            if (char === 0) return str;
            str += String.fromCharCode(char);
        }
        throw new Error("End of buffer reached.");
    }

    const signature = readString(10);
    if (signature !== "UnityFS" && signature !== "UnityRaw") throw new Error("Invalid signature.");
    if (pos + 24 > view.byteLength) throw new Error("Header truncated.");

    const formatVersion = view.getUint32(pos, false); pos += 4;
    const unityVersion = readString(32);
    const unityRevision = readString(32);

    if (pos + 20 > view.byteLength) throw new Error("Header truncated.");

    const size = Number(view.getBigUint64(pos, false)); pos += 8;
    const ciBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const uiBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const flags = view.getUint32(pos, false); pos += 4;

    const headerSize = pos - localOffset;
    const blocksAtEnd = (flags & 0x80) !== 0;

    let blocksInfoAbsoluteOffset = 0;
    let dataStartAbsoluteOffset = 0;

    if (blocksAtEnd) {
        blocksInfoAbsoluteOffset = absoluteOffset + size - ciBlocksInfoSize; 
        dataStartAbsoluteOffset = absoluteOffset + headerSize;
    } else {
        blocksInfoAbsoluteOffset = absoluteOffset + headerSize;
        dataStartAbsoluteOffset = absoluteOffset + headerSize + ciBlocksInfoSize;
    }

    self.postMessage({ 
        type: 'LOG', 
        data: `[BUNDLE FOUND] Offset: 0x${absoluteOffset.toString(16).toUpperCase()} | Size: ${(size/1024/1024).toFixed(2)}MB`, 
        logType: 'success' 
    });

    if (wasmEngineReady) {
        const byteLength = u8Array.byteLength - localOffset;
        const ptr = Module._malloc(byteLength);
        
        Module.HEAPU8.set(u8Array.subarray(localOffset), ptr);
        Module._process_unity_archive(ptr, byteLength, absoluteOffset, dataStartAbsoluteOffset, blocksInfoAbsoluteOffset);
        Module._free(ptr);
    } else {
        self.postMessage({ 
            type: 'LOG', 
            data: `Cannot process bundle. C++ WASM Engine is offline.`, 
            logType: 'error' 
        });
    }
}

function extractRealAssetNames(u8, chunkOffset) {
    let str = "";
    let matches = 0;
    for (let i = 0; i < u8.length; i++) {
        const charCode = u8[i];
        if (charCode >= 32 && charCode <= 126) {
            str += String.fromCharCode(charCode);
        } else {
            if (str.length > 6) {
                const lowerStr = str.toLowerCase();
                if (lowerStr.includes('.mesh') || lowerStr.includes('.mat') || lowerStr.includes('.tex') || str.startsWith('CAB-')) {
                    self.postMessage({ type: 'ASSET_FOUND_META', data: { name: str, offset: chunkOffset + i } });
                    matches++;
                    if (matches > 20) break; 
                }
            }
            str = ""; 
        }
    }
}

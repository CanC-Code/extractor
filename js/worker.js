// js/worker.js - FIXED & INTEGRATED VERSION
// Place this in your js/ folder. Ensure ../build/parser.js and ../build/parser.wasm exist.

importScripts('../build/parser.js');

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024; // 10MB chunks
        let offset = 0;

        self.postMessage({ 
            type: 'LOG', 
            data: `Worker initialized. Loading WASM parser engine...`, 
            logType: 'system' 
        });

        // Wait for WASM to be ready
        if (typeof Module === 'undefined' || !Module.onRuntimeInitialized) {
            self.postMessage({ 
                type: 'LOG', 
                data: `Waiting for WASM runtime initialization...`, 
                logType: 'system' 
            });
        }

        const processBundle = (absoluteOffset, dataStart, blocksInfo, version) => {
            self.postMessage({ 
                type: 'LOG', 
                data: `🚀 Bridging to C++ at 0x${absoluteOffset.toString(16).toUpperCase()} (v${version})`, 
                logType: 'success' 
            });

            try {
                // Call the Emscripten-exported function
                if (typeof Module._process_unity_archive === 'function') {
                    Module._process_unity_archive(
                        Number(absoluteOffset), 
                        Number(dataStart), 
                        Number(blocksInfo)
                    );
                } else {
                    self.postMessage({ 
                        type: 'LOG', 
                        data: `WASM function _process_unity_archive not found yet.`, 
                        logType: 'warning' 
                    });
                }
            } catch (err) {
                self.postMessage({ 
                    type: 'LOG', 
                    data: `WASM call error: ${err.message}`, 
                    logType: 'error' 
                });
            }
        };

        const readNextChunk = () => {
            if (offset >= file.size) {
                self.postMessage({ 
                    type: 'LOG', 
                    data: `Full scan complete. WASM extraction in progress.`, 
                    logType: 'success' 
                });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const buffer = evt.target.result;
                const view = new DataView(buffer);
                const u8 = new Uint8Array(buffer);

                const percent = Math.min(100, Math.floor((offset / file.size) * 100));
                self.postMessage({ type: 'PROGRESS', data: percent });

                // === UNITYFS HEADER SCAN ===
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && 
                        u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        
                        const absoluteOffset = offset + i;

                        try {
                            const { dataStart, blocksInfo, unityVersion } = 
                                parseUnityFSHeader(view, i, absoluteOffset, file.size);
                            
                            if (dataStart && blocksInfo) {
                                processBundle(absoluteOffset, dataStart, blocksInfo, unityVersion);
                            }
                        } catch (err) {
                            // False positive - common in compressed data
                        }
                    }
                }

                // Light asset name extraction
                extractRealAssetNames(u8, offset);

                offset += chunkSize;
                setTimeout(readNextChunk, 5); // Small delay to keep UI responsive
            };

            reader.onerror = () => {
                self.postMessage({ 
                    type: 'LOG', 
                    data: `Read error at offset ${offset}`, 
                    logType: 'error' 
                });
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

// Keep your existing helper functions (updated for robustness)
function parseUnityFSHeader(view, localOffset, absoluteOffset, totalFileSize) {
    let pos = localOffset;

    function readString(maxLen = 64) {
        let str = '';
        const start = pos;
        while (pos < view.byteLength && (pos - start) < maxLen) {
            const char = view.getUint8(pos++);
            if (char === 0) return str;
            str += String.fromCharCode(char);
        }
        return str;
    }

    const signature = readString(10);
    if (!signature.startsWith("UnityFS") && !signature.startsWith("UnityRaw")) {
        throw new Error("Invalid signature");
    }

    if (pos + 24 > view.byteLength) throw new Error("Header truncated");

    const formatVersion = view.getUint32(pos, false); pos += 4;
    const unityVersion = readString(32);
    const unityRevision = readString(32);

    if (pos + 20 > view.byteLength) throw new Error("Sizes truncated");

    const size = Number(view.getBigUint64(pos, false)); pos += 8;
    const ciBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const uiBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const flags = view.getUint32(pos, false); pos += 4;

    const headerSize = pos - localOffset;
    const blocksAtEnd = (flags & 0x80) !== 0;

    let blocksInfoAbsoluteOffset, dataStartAbsoluteOffset;

    if (blocksAtEnd) {
        blocksInfoAbsoluteOffset = absoluteOffset + size - ciBlocksInfoSize;
        dataStartAbsoluteOffset = absoluteOffset + headerSize;
    } else {
        blocksInfoAbsoluteOffset = absoluteOffset + headerSize;
        dataStartAbsoluteOffset = absoluteOffset + headerSize + ciBlocksInfoSize;
    }

    self.postMessage({ 
        type: 'LOG', 
        data: `[BUNDLE] 0x${absoluteOffset.toString(16).toUpperCase()} | ${unityVersion} | ~${(size/1024/1024).toFixed(1)}MB`, 
        logType: 'success' 
    });

    return {
        dataStart: dataStartAbsoluteOffset,
        blocksInfo: blocksInfoAbsoluteOffset,
        unityVersion
    };
}

function extractRealAssetNames(u8, chunkOffset) {
    let str = "";
    let matches = 0;

    for (let i = 0; i < u8.length; i++) {
        const cc = u8[i];
        if (cc >= 32 && cc <= 126) {
            str += String.fromCharCode(cc);
        } else {
            if (str.length > 8) {
                const lower = str.toLowerCase();
                if (lower.includes('.mesh') || lower.includes('.mat') || 
                    lower.includes('.tex') || lower.includes('.png') || 
                    lower.includes('.asset') || str.startsWith('CAB-')) {
                    
                    self.postMessage({ 
                        type: 'ASSET_FOUND_META', 
                        data: { name: str.substring(0, 120), offset: chunkOffset + i - str.length } 
                    });
                    matches++;
                    if (matches > 15) break;
                }
            }
            str = "";
        }
    }
}
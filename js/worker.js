// js/worker.js - Full Integrated Version
importScripts('../build/parser.js');

let wasmModuleReady = false;

Module.onRuntimeInitialized = function() {
    wasmModuleReady = true;
    self.postMessage({ 
        type: 'LOG', 
        data: '✅ WASM Parser Engine successfully initialized!', 
        logType: 'success' 
    });
};

self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024; // 10MB
        let offset = 0;

        self.postMessage({ 
            type: 'LOG', 
            data: `Starting chunked scan of ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`, 
            logType: 'system' 
        });

        const processBundle = (bundleOffset, dataStart, blocksInfo, version) => {
            if (!wasmModuleReady) {
                self.postMessage({ 
                    type: 'LOG', 
                    data: 'WASM not ready yet - will retry on next bundle', 
                    logType: 'warning' 
                });
                return;
            }

            try {
                // Use BigInt because file offsets can exceed 2^53
                Module._process_unity_archive(
                    BigInt(bundleOffset),
                    BigInt(dataStart),
                    BigInt(blocksInfo)
                );

                self.postMessage({ 
                    type: 'LOG', 
                    data: `📦 Sent bundle to WASM: 0x${bundleOffset.toString(16).toUpperCase()} (${version})`, 
                    logType: 'success' 
                });
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
                    data: '✅ Full file scan completed. WASM extraction running.', 
                    logType: 'success' 
                });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const buffer = evt.target.result;
                const u8 = new Uint8Array(buffer);
                const view = new DataView(buffer);

                const percent = Math.min(100, Math.floor(((offset + chunkSize) / file.size) * 100));
                self.postMessage({ type: 'PROGRESS', data: percent });

                // === Scan for UnityFS headers ===
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i]     === 85 && u8[i+1] === 110 && u8[i+2] === 105 && 
                        u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        
                        const absoluteOffset = offset + i;

                        try {
                            const headerInfo = parseUnityFSHeader(view, i, absoluteOffset, file.size);
                            if (headerInfo) {
                                processBundle(
                                    absoluteOffset, 
                                    headerInfo.dataStart, 
                                    headerInfo.blocksInfo, 
                                    headerInfo.version
                                );
                            }
                        } catch (err) {
                            // False positive - ignore
                        }
                    }
                }

                // Extract asset names (meshes, textures, etc.)
                extractRealAssetNames(u8, offset);

                offset += chunkSize;
                setTimeout(readNextChunk, 8); // Keep UI responsive
            };

            reader.onerror = function() {
                self.postMessage({ 
                    type: 'LOG', 
                    data: `Error reading chunk at offset ${offset}`, 
                    logType: 'error' 
                });
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

// ====================== Helper Functions ======================

function parseUnityFSHeader(view, localOffset, absoluteOffset, totalFileSize) {
    let pos = localOffset;

    function readString(maxLen = 64) {
        let str = '';
        let start = pos;
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

    if (pos + 20 > view.byteLength) throw new Error("Header sizes truncated");

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
        data: `[BUNDLE FOUND] 0x${absoluteOffset.toString(16).toUpperCase()} | ${unityVersion} | ${(size/1024/1024).toFixed(1)}MB`, 
        logType: 'success' 
    });

    return {
        dataStart: dataStartAbsoluteOffset,
        blocksInfo: blocksInfoAbsoluteOffset,
        version: unityVersion
    };
}

function extractRealAssetNames(u8, chunkOffset) {
    let str = "";
    let count = 0;

    for (let i = 0; i < u8.length; i++) {
        const cc = u8[i];

        if (cc >= 32 && cc <= 126) {
            str += String.fromCharCode(cc);
        } else {
            if (str.length > 8) {
                const lower = str.toLowerCase();
                if (lower.includes('.mesh') || lower.includes('.mat') || 
                    lower.includes('.tex') || lower.includes('.png') || 
                    lower.includes('.asset') || lower.includes('.prefab') || 
                    str.startsWith('CAB-')) {

                    self.postMessage({ 
                        type: 'ASSET_FOUND_META', 
                        data: { 
                            name: str.substring(0, 128), 
                            offset: chunkOffset + i - str.length 
                        } 
                    });
                    count++;
                    if (count > 20) break; // limit spam
                }
            }
            str = "";
        }
    }
}
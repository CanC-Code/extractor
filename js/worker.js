self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024; // 10MB chunks
        let offset = 0;
        let foundUnityFS = false;

        self.postMessage({ type: 'LOG', data: `Beginning chunked deep scan of binary stream...`, logType: 'system' });
        self.postMessage({ type: 'PROGRESS', data: 0 });

        const readNextChunk = () => {
            if (offset >= file.size) {
                self.postMessage({ type: 'LOG', data: `Scan complete. Waiting for Wasm module for full extraction.`, logType: 'system' });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const buffer = evt.target.result;
                const view = new DataView(buffer);
                const u8 = new Uint8Array(buffer);
                
                const percent = ((offset / file.size) * 100).toFixed(1);
                self.postMessage({ type: 'PROGRESS', data: percent });

                // Scan for UnityFS header if not found
                if (!foundUnityFS) {
                    for (let i = 0; i < u8.length - 7; i++) {
                        if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                            foundUnityFS = true;
                            const absoluteOffset = offset + i;
                            self.postMessage({ type: 'LOG', data: `MATCH: UnityFS Header at 0x${absoluteOffset.toString(16).toUpperCase()}`, logType: 'success' });
                            
                            try {
                                parseUnityFSHeader(view, i, absoluteOffset, file.size);
                            } catch (err) {
                                self.postMessage({ type: 'LOG', data: `Header Parse Error: ${err.message}`, logType: 'error' });
                            }
                        }
                    }
                }

                // Continue scanning for asset strings
                extractRealAssetNames(u8, offset);

                offset += chunkSize;
                setTimeout(readNextChunk, 15); 
            };

            reader.onerror = function() {
                self.postMessage({ type: 'LOG', data: `Buffer read error at offset ${offset}`, logType: 'error' });
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk(); 
    }
};

function parseUnityFSHeader(view, localOffset, absoluteOffset, totalFileSize) {
    let pos = localOffset;

    // Helper to read null-terminated strings
    function readString() {
        let str = '';
        while (pos < view.byteLength) {
            let char = view.getUint8(pos++);
            if (char === 0) break;
            str += String.fromCharCode(char);
        }
        return str;
    }

    const signature = readString();
    
    // UnityFS uses Big-Endian for its header integers
    const formatVersion = view.getUint32(pos, false); pos += 4;
    const unityVersion = readString();
    const unityRevision = readString();
    
    // Size is an Int64. Number() is safe here as long as files are < 9PB.
    const size = Number(view.getBigUint64(pos, false)); pos += 8;
    const ciBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const uiBlocksInfoSize = view.getUint32(pos, false); pos += 4;
    const flags = view.getUint32(pos, false); pos += 4;

    const headerSize = pos - localOffset;
    
    // THE FIX: Bitwise check for the blocksAtEnd flag (0x80)
    const blocksAtEnd = (flags & 0x80) !== 0;

    let blocksInfoAbsoluteOffset = 0;
    let dataStartAbsoluteOffset = 0;

    if (blocksAtEnd) {
        // Blocks info is at the end of the total logical file size.
        // Data payload starts IMMEDIATELY after the header.
        blocksInfoAbsoluteOffset = absoluteOffset + size - ciBlocksInfoSize; 
        dataStartAbsoluteOffset = absoluteOffset + headerSize;
    } else {
        // Blocks info immediately follows the header.
        // Data payload starts AFTER the blocks info.
        blocksInfoAbsoluteOffset = absoluteOffset + headerSize;
        dataStartAbsoluteOffset = absoluteOffset + headerSize + ciBlocksInfoSize;
    }

    self.postMessage({ 
        type: 'LOG', 
        data: `Archive: ${unityVersion} | Size: ${(size/1024/1024).toFixed(2)}MB | BlocksAtEnd: ${blocksAtEnd}`, 
        logType: 'system' 
    });

    self.postMessage({ 
        type: 'LOG', 
        data: `Data Start: 0x${dataStartAbsoluteOffset.toString(16).toUpperCase()} | Blocks Info: 0x${blocksInfoAbsoluteOffset.toString(16).toUpperCase()}`, 
        logType: 'data' 
    });

    // We no longer read data out of bounds. The decompressor / Wasm pipeline 
    // now has the exact absolute offsets it needs to slice the file correctly.
}

// Filters raw binary to find legitimate Unity asset names and paths
function extractRealAssetNames(u8, chunkOffset) {
    let str = "";
    let matches = 0;

    for (let i = 0; i < u8.length; i++) {
        const charCode = u8[i];
        
        // Match standard printable ASCII characters
        if (charCode >= 32 && charCode <= 126) {
            str += String.fromCharCode(charCode);
        } else {
            if (str.length > 6) {
                const lowerStr = str.toLowerCase();
                if (lowerStr.includes('.mesh') || 
                    lowerStr.includes('.mat') || 
                    lowerStr.includes('.tex') || 
                    lowerStr.includes('.prefab') || 
                    str.startsWith('CAB-') ||
                    lowerStr.includes('assets/')) {
                    
                    self.postMessage({ type: 'LOG', data: `FOUND ASSET: ${str}`, logType: 'data' });
                    
                    self.postMessage({ 
                        type: 'ASSET_FOUND_META', 
                        data: { name: str, offset: chunkOffset + i } 
                    });
                    
                    matches++;
                    if (matches > 15) break; 
                }
            }
            str = ""; 
        }
    }
}

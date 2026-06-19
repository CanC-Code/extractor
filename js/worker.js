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
                self.postMessage({ type: 'LOG', data: `Scan complete. Waiting for Wasm module for LZ4 decompression.`, logType: 'system' });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const u8 = new Uint8Array(evt.target.result);
                const percent = ((offset / file.size) * 100).toFixed(1);
                
                self.postMessage({ type: 'PROGRESS', data: percent });
                self.postMessage({ type: 'LOG', data: `Scanning block 0x${offset.toString(16).toUpperCase()}...` });

                // Scan for actual Unity asset names, ignoring binary garbage
                extractRealAssetNames(u8, offset);

                // Scan for UnityFS header
                if (!foundUnityFS) {
                    for (let i = 0; i < u8.length - 7; i++) {
                        if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                            foundUnityFS = true;
                            const absoluteOffset = offset + i;
                            self.postMessage({ type: 'LOG', data: `MATCH: UnityFS Header at 0x${absoluteOffset.toString(16).toUpperCase()}`, logType: 'success' });
                        }
                    }
                }

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
                // Unity assets typically have specific extensions, paths, or start with CAB-
                const lowerStr = str.toLowerCase();
                if (lowerStr.includes('.mesh') || 
                    lowerStr.includes('.mat') || 
                    lowerStr.includes('.tex') || 
                    lowerStr.includes('.prefab') || 
                    str.startsWith('CAB-') ||
                    lowerStr.includes('assets/')) {
                    
                    self.postMessage({ type: 'LOG', data: `FOUND ASSET: ${str}`, logType: 'data' });
                    
                    // Route to UI to populate the Asset list dynamically
                    self.postMessage({ 
                        type: 'ASSET_FOUND_META', 
                        data: { name: str, offset: chunkOffset + i } 
                    });
                    
                    matches++;
                    if (matches > 15) break; // Prevent log flooding per chunk
                }
            }
            str = ""; // Reset string builder
        }
    }
}

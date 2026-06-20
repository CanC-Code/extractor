// js/worker.js
// Handles real binary parsing of the APK/ZIP structure to locate genuine assets.

function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

onmessage = async function(e) {
    const { type, file, assetMeta } = e.data;

    if (type === 'PROCESS_FILE') {
        log(`Worker initiated binary scan for ${file.name}`);
        
        try {
            // Read the file into an ArrayBuffer for byte-level scanning
            const buffer = await file.arrayBuffer();
            const arr = new Uint8Array(buffer);
            const decoder = new TextDecoder('utf-8');
            let foundCount = 0;

            log("Scanning for ZIP local file headers...", "info");

            // Fast byte-by-byte scan for PK\x03\x04 signatures
            for (let i = 0; i < arr.length - 30; i++) {
                if (arr[i] === 0x50 && arr[i+1] === 0x4B && arr[i+2] === 0x03 && arr[i+3] === 0x04) {
                    
                    const view = new DataView(buffer, i, 30);
                    const compressionMethod = view.getUint16(8, true);
                    const compSize = view.getUint32(18, true);
                    const nameLen = view.getUint16(26, true);
                    const extraLen = view.getUint16(28, true);
                    
                    // Prevent out-of-bounds reading for corrupted headers
                    if (i + 30 + nameLen <= arr.length) {
                        const nameBytes = new Uint8Array(buffer, i + 30, nameLen);
                        const name = decoder.decode(nameBytes);
                        const dataOffset = i + 30 + nameLen + extraLen;

                        postMessage({
                            type: 'ASSET_FOUND_META',
                            data: {
                                name: name,
                                offset: dataOffset,
                                size: compSize,
                                compressed: compressionMethod !== 0
                            }
                        });
                        foundCount++;
                    }
                    
                    // Optimization: Skip ahead by the compressed size if available
                    // This prevents scanning the binary data payloads unnecessarily
                    if (compSize > 0) {
                        i += (29 + nameLen + extraLen + compSize);
                    }
                }
            }

            log(`Scan complete. Found ${foundCount} valid files in archive.`, "success");

        } catch (err) {
            log(`File reading error: ${err.message}`, 'error');
        }
    } 
    else if (type === 'EXTRACT_ASSET') {
        const { offset, size, name } = assetMeta;
        
        try {
            // Extract the specific byte chunk directly from the File object
            const chunk = file.slice(offset, offset + size);
            const arrayBuffer = await chunk.arrayBuffer();
            
            const isModel = name.match(/\.(mesh|fbx|obj|prefab)$/i) !== null;

            postMessage({
                type: 'ASSET_EXTRACTED',
                data: {
                    name: name,
                    buffer: arrayBuffer,
                    isModel: isModel
                }
            }, [arrayBuffer]); 

        } catch (err) {
            log(`Extraction failed for ${name}: ${err.message}`, 'error');
        }
    }
};

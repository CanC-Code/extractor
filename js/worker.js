// js/worker.js
function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

onmessage = async function(e) {
    const { type, file, assetMeta, isContainer } = e.data;

    if (type === 'PROCESS_FILE') {
        log(`Worker initiated binary scan for ${file.name}`);
        
        try {
            const buffer = await file.arrayBuffer();
            const arr = new Uint8Array(buffer);
            const decoder = new TextDecoder('utf-8');
            let foundCount = 0;

            log("Scanning for ZIP local file headers...", "info");

            for (let i = 0; i < arr.length - 30; i++) {
                if (arr[i] === 0x50 && arr[i+1] === 0x4B && arr[i+2] === 0x03 && arr[i+3] === 0x04) {
                    
                    const view = new DataView(buffer, i, 30);
                    const compressionMethod = view.getUint16(8, true);
                    const compSize = view.getUint32(18, true);
                    const nameLen = view.getUint16(26, true);
                    const extraLen = view.getUint16(28, true);
                    
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
            const chunk = file.slice(offset, offset + size);
            const arrayBuffer = await chunk.arrayBuffer();

            postMessage({
                type: 'ASSET_EXTRACTED',
                data: {
                    name: name,
                    buffer: arrayBuffer,
                    isContainer: isContainer
                }
            }, [arrayBuffer]); 

        } catch (err) {
            log(`Extraction failed for ${name}: ${err.message}`, 'error');
        }
    }
};

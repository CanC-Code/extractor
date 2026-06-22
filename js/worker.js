// src/worker.js
let wasmExports = null;
let wasmReady = false;

// 1. Dynamic File Identification
function identifyFileExtension(u8, currentName) {
    if (u8.length < 16) return currentName;
    
    // Check UnityFS Magic ("UnityFS", "UnityWe", "UnityRa")
    const magicFS = String.fromCharCode(...u8.slice(0, 7));
    if (magicFS === 'UnityFS' || magicFS === 'UnityWe' || magicFS === 'UnityRa') {
        if (!currentName.endsWith('.unity3d')) return currentName + '.unity3d';
        return currentName;
    }
    
    // Check APK / ZIP Magic (PK\x03\x04)
    if (u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04) {
        if (!currentName.endsWith('.apk') && !currentName.endsWith('.zip')) return currentName + '.apk';
        return currentName;
    }
    
    // Check MP4 / Video Magic (ftyp)
    if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
        if (!currentName.endsWith('.mp4')) return currentName + '.mp4';
        return currentName;
    }
    
    // Check SerializedFile (Format 22 check or Unity Version string sniff)
    if (u8[0] === 0 && u8[1] === 0 && u8[2] === 0) {
        let hasVersion = false;
        for (let i = 0; i < Math.min(u8.length - 5, 128); i++) {
            if ((u8[i] === 0x36 && u8[i+1] === 0x30 && u8[i+2] === 0x30 && u8[i+3] === 0x30 && u8[i+4] === 0x2E) || // "6000."
                (u8[i] === 0x35 && u8[i+1] === 0x2E && u8[i+2] === 0x78 && u8[i+3] === 0x2E)) { // "5.x."
                hasVersion = true;
                break;
            }
        }
        if (hasVersion || (u8.length > 12 && u8[11] === 0x16)) { // 0x16 = Format 22
            if (!currentName.endsWith('.assets')) return currentName + '.assets';
            return currentName;
        }
    }
    
    return currentName;
}

// 2. Archive Processor (Extracts ZIP / APK files internally)
async function processArchive(u8, archiveName) {
    self.postMessage({ type: 'LOG', msg: `[Archive] Unpacking container: ${archiveName}...` });
    let offset = 0;
    let dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    while (offset < u8.length - 4) {
        // Look for Zip Local File Header (PK\x03\x04 Little Endian)
        if (dv.getUint32(offset, true) === 0x04034b50) { 
            let compMethod = dv.getUint16(offset + 8, true);
            let compSize = dv.getUint32(offset + 18, true);
            let uncompSize = dv.getUint32(offset + 22, true);
            let nameLen = dv.getUint16(offset + 26, true);
            let extraLen = dv.getUint16(offset + 28, true);
            
            let nameOffset = offset + 30;
            let dataOffset = nameOffset + nameLen + extraLen;
            
            // Validate bounds bounds limit memory overflow crashes
            if (dataOffset + compSize > u8.length) break;

            let fileName = "";
            for (let i = 0; i < nameLen; i++) {
                fileName += String.fromCharCode(u8[nameOffset + i]);
            }
            
            // If it's an actual file and not just a directory layout
            if (compSize > 0 && !fileName.endsWith('/')) {
                let fileData = u8.subarray(dataOffset, dataOffset + compSize);
                
                try {
                    if (compMethod === 0) {
                        // STORED (No compression - Used commonly by Unity for large APK assets)
                        await processExtractedFile(fileData, fileName);
                    } else if (compMethod === 8) {
                        // DEFLATE (Use native Web DecompressionStream for rapid unzipping)
                        const ds = new DecompressionStream('deflate-raw');
                        const writer = ds.writable.getWriter();
                        writer.write(fileData).catch(()=>{});
                        writer.close().catch(()=>{});
                        const response = new Response(ds.readable);
                        const buffer = await response.arrayBuffer();
                        await processExtractedFile(new Uint8Array(buffer), fileName);
                    }
                } catch (err) {
                    // Fail silently for individual corrupted inner files rather than halting the entire archive iteration
                }
            }
            offset = dataOffset + compSize;
            
        } else if (dv.getUint32(offset, true) === 0x02014b50) {
            break; // Reached Central Directory boundary, extraction complete.
        } else {
            // Find next local file header (brute force resync)
            let found = false;
            for (let i = offset + 1; i < u8.length - 4; i++) {
                if (dv.getUint32(i, true) === 0x04034b50 || dv.getUint32(i, true) === 0x02014b50) {
                    offset = i;
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }
    }
    self.postMessage({ type: 'LOG', msg: `[Archive] Finished unpacking ${archiveName}` });
}

async function processExtractedFile(u8, fileName) {
    let name = identifyFileExtension(u8, fileName);
    if (name.endsWith('.unity3d')) {
        processUnityFS(u8, name);
    } else if (name.endsWith('.assets')) {
        processSerializedFile(u8, name);
    }
}

// 3. UnityFS Header Parser
function processUnityFS(u8, name) {
    let dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 0;
    
    function readString() {
        let str = '';
        while (offset < u8.length && u8[offset] !== 0) {
            str += String.fromCharCode(u8[offset]);
            offset++;
        }
        offset++;
        return str;
    }
    
    let magic = readString();
    let version = dv.getUint32(offset, false); offset += 4;
    let unityVersion = readString();
    let minRevision = readString();
    
    let bundleSize = 0n;
    let ciSize = 0;
    let uiSize = 0;
    let flags = 0;
    
    // Validate 64-bit bounds limits
    if (version >= 6) {
        bundleSize = dv.getBigUint64(offset, false); offset += 8;
        ciSize = dv.getUint32(offset, false); offset += 4;
        uiSize = dv.getUint32(offset, false); offset += 4;
        flags = dv.getUint32(offset, false); offset += 4;
    } else {
        bundleSize = BigInt(dv.getUint32(offset, false)); offset += 4;
        ciSize = dv.getUint32(offset, false); offset += 4;
        uiSize = dv.getUint32(offset, false); offset += 4;
        flags = dv.getUint32(offset, false); offset += 4;
    }
    
    let compression = flags & 0x3F;
    let blocksAtEnd = (flags & 0x80) !== 0;
    
    // Log the cleaned file name alongside format version for debugging verification
    self.postMessage({ type: 'LOG', msg: `UnityFS Extracted: ${name.split('/').pop()} (Ver:${version}, Comp:${compression})` });

    if (compression === 3 || compression === 2) {
        // LZ4HC block routing logic utilizing WASM backend 
    }
}

function processSerializedFile(u8, name) {
    self.postMessage({ type: 'LOG', msg: `SerializedFile Found: ${name.split('/').pop()}` });
    // Asset extraction routines
}

// 4. Main Worker Message Loop
self.onmessage = async (e) => {
    if (e.data.type === 'INIT') {
        wasmReady = true;
        self.postMessage({ type: 'LOG', msg: 'Worker engine initialized.' });
    } else if (e.data.type === 'PROCESS_FILE') {
        try {
            const file = e.data.file;
            const arrayBuffer = await file.arrayBuffer();
            const u8 = new Uint8Array(arrayBuffer);
            
            let name = identifyFileExtension(u8, file.name);
            
            // Route processing based on magic/sniffed extensions
            if (name.endsWith('.apk') || name.endsWith('.zip')) {
                await processArchive(u8, name);
            } else if (name.endsWith('.unity3d')) {
                processUnityFS(u8, name);
            } else if (name.endsWith('.assets')) {
                processSerializedFile(u8, name);
            } else if (name.endsWith('.mp4')) {
                self.postMessage({ type: 'LOG', msg: `[Media] Skipping MP4 Video: ${name}` });
            } else {
                self.postMessage({ type: 'LOG', msg: `[Unknown] Ignored undefined format: ${name}` });
            }
        } catch (err) {
            // Safely fallback to error strings to entirely prevent "undefined" console errors
            const errorOutput = err.message ? err.message : String(err);
            self.postMessage({ type: 'LOG', msg: `EXCEPTION ERROR: ${errorOutput}` });
        } finally {
            // Guarantee completion signal reaches UI to clear scanning block
            self.postMessage({ type: 'DONE' });
        }
    }
};

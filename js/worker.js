// src/worker.js
let wasmExports = null;
let wasmReady = false;

// 1. Dynamic File Identification
// Identifies raw asset files by their magic bytes and appends correct extensions
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
    
    // Check SerializedFile
    // SerializedFiles lack a string magic but start with small BE 32-bit integers (Metadata Size, File Size, Version)
    // We sniff for Unity version strings ("6000.", "202") or Format 22 identifier (0x16)
    let dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8[0] === 0 && u8[1] === 0 && u8[2] === 0) {
        let hasVersion = false;
        // Scan first 128 bytes for common Unity version prefixes
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

// 2. Main File Processing Loop
self.onmessage = async (e) => {
    if (e.data.type === 'INIT') {
        wasmReady = true;
        self.postMessage({ type: 'LOG', msg: 'Worker engine initialized.' });
    } else if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const arrayBuffer = await file.arrayBuffer();
        const u8 = new Uint8Array(arrayBuffer);
        
        // Dynamically append extensions based on binary inspection
        let name = identifyFileExtension(u8, file.name);
        
        if (name.endsWith('.unity3d')) {
            processUnityFS(u8, name);
        } else if (name.endsWith('.assets')) {
            processSerializedFile(u8, name);
        } else if (name.endsWith('.apk') || name.endsWith('.zip')) {
            self.postMessage({ type: 'LOG', msg: `[Archive] Detected container: ${name}. Ensure it is extracted.` });
        } else if (name.endsWith('.mp4')) {
             self.postMessage({ type: 'LOG', msg: `[Media] Skipping MP4 Video: ${name}` });
        } else {
            self.postMessage({ type: 'LOG', msg: `[Unknown] Ignored undefined format: ${name}` });
        }
        
        self.postMessage({ type: 'DONE' });
    }
};

// 3. UnityFS Header Parser (Fixed for Format 8 64-bit bounds)
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
    
    // UnityFS Format 6+ strictly enforces 64-bit (8 bytes) for BundleSize
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
    
    // Debug verification mapping
    self.postMessage({ type: 'LOG', msg: `UnityFS: ${name} (Ver:${version}, Comp:${compression})` });

    // Ensure parser targets LZ4HC (3) properly without throwing arbitrary ASCII shifts
    if (compression === 3 || compression === 2) {
        // Delegate to WASM decompression here
        // const decompressed = self.Module.ccall('decompress_lz4', ...);
    } else if (compression !== 0) {
        self.postMessage({ type: 'LOG', msg: `Unsupported compression: ${compression}` });
    }
}

// 4. Serialized File Handler
function processSerializedFile(u8, name) {
    self.postMessage({ type: 'LOG', msg: `SerializedFile: ${name}` });
    // Parse metadata, extract Texture2D / Mesh instances, map to ArrayBuffer objects
}

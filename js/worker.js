// ============================================================
// BACKGROUND PARSE WORKER
// Chunked binary scan of APK/bundle files for Unity assets.
// Sends classified messages back to the main thread.
// ============================================================

// Asset type classification
const ASSET_TYPES = {
    MODEL:   'model',
    TEXTURE: 'texture',
    AUDIO:   'audio',
    MATERIAL:'material',
    SCENE:   'scene',
    OTHER:   'other',
};

// Extensions that map to 3D model assets
const MODEL_EXTENSIONS = [
    '.mesh', '.fbx', '.obj', '.glb', '.gltf', '.3ds', '.dae',
    '.lwo', '.ma', '.mb', '.blend', '.asset', '.prefab'
];

// Unity internal mesh type identifiers found in serialized data
const UNITY_MESH_KEYWORDS = ['Mesh', 'SkinnedMeshRenderer', 'MeshFilter', 'MeshRenderer'];

function classifyAsset(name) {
    const lower = name.toLowerCase();

    if (MODEL_EXTENSIONS.some(ext => lower.endsWith(ext))) return ASSET_TYPES.MODEL;
    if (UNITY_MESH_KEYWORDS.some(kw => name.includes(kw))) return ASSET_TYPES.MODEL;
    if (['.png','.jpg','.jpeg','.tga','.exr','.hdr','.bmp','.tex','.texture2d'].some(e => lower.endsWith(e))) return ASSET_TYPES.TEXTURE;
    if (['.wav','.ogg','.mp3','.aiff','.audioclip'].some(e => lower.endsWith(e))) return ASSET_TYPES.AUDIO;
    if (['.mat','.material'].some(e => lower.endsWith(e))) return ASSET_TYPES.MATERIAL;
    if (['.unity','.scene'].some(e => lower.endsWith(e))) return ASSET_TYPES.SCENE;

    return ASSET_TYPES.OTHER;
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 8 * 1024 * 1024; // 8 MB chunks
        let offset = 0;

        // Deduplication across all chunks
        const seenNames = new Set();
        const seenCabs = new Set();
        let unityFSOffsets = [];

        self.postMessage({ type: 'LOG', data: `Beginning chunked deep scan of binary stream...`, logType: 'system' });
        self.postMessage({ type: 'PROGRESS', data: 0 });

        const readNextChunk = () => {
            if (offset >= file.size) {
                const summary = `Scan complete. Found ${unityFSOffsets.length} UnityFS block(s).`;
                self.postMessage({ type: 'LOG', data: summary, logType: 'system' });
                self.postMessage({ type: 'PROGRESS', data: 100 });
                self.postMessage({ type: 'SCAN_COMPLETE', data: { unityFSCount: unityFSOffsets.length } });
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const u8 = new Uint8Array(evt.target.result);
                const percent = Math.min(((offset / file.size) * 100), 99).toFixed(1);

                self.postMessage({ type: 'PROGRESS', data: percent });
                self.postMessage({ type: 'LOG', data: `Scanning block 0x${offset.toString(16).toUpperCase()}...` });

                // --- 1. Scan for UnityFS headers (all occurrences) ---
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i]   === 0x55 && u8[i+1] === 0x6E && u8[i+2] === 0x69 &&
                        u8[i+3] === 0x74 && u8[i+4] === 0x79 && u8[i+5] === 0x46 &&
                        u8[i+6] === 0x53) {
                        const absOffset = offset + i;
                        unityFSOffsets.push(absOffset);
                        self.postMessage({
                            type: 'LOG',
                            data: `MATCH: UnityFS Header at 0x${absOffset.toString(16).toUpperCase()}`,
                            logType: 'success'
                        });
                    }
                }

                // --- 2. Scan for string assets & classify them ---
                scanStrings(u8, offset, seenNames, seenCabs);

                offset += chunkSize;
                setTimeout(readNextChunk, 10);
            };

            reader.onerror = function() {
                self.postMessage({ type: 'LOG', data: `Buffer read error at offset 0x${offset.toString(16).toUpperCase()}`, logType: 'error' });
                offset += chunkSize;
                setTimeout(readNextChunk, 10);
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    }
};

// ============================================================
// STRING SCANNER
// Extracts printable ASCII runs and classifies them.
// No per-chunk match cap — we want ALL models.
// ============================================================
function scanStrings(u8, chunkOffset, seenNames, seenCabs) {
    let str = '';
    const MIN_LEN = 5;

    for (let i = 0; i <= u8.length; i++) {
        const code = i < u8.length ? u8[i] : 0;
        const printable = code >= 0x20 && code <= 0x7E;

        if (printable) {
            str += String.fromCharCode(code);
        } else {
            if (str.length >= MIN_LEN) {
                processCandidate(str, chunkOffset + i - str.length, seenNames, seenCabs);
            }
            str = '';
        }
    }
}

function processCandidate(str, absOffset, seenNames, seenCabs) {
    // --- CAB bundles (Unity container bundles) ---
    if (str.startsWith('CAB-') && str.length > 10) {
        if (!seenCabs.has(str)) {
            seenCabs.add(str);
            self.postMessage({
                type: 'LOG',
                data: `FOUND ASSET: ${str}`,
                logType: 'data'
            });
            self.postMessage({
                type: 'ASSET_FOUND_META',
                data: { name: str, offset: absOffset, assetType: ASSET_TYPES.OTHER, isCab: true }
            });
        }
        return;
    }

    // --- Path-style assets (assets/... or Assets/...) ---
    const lower = str.toLowerCase();
    const isPath = lower.startsWith('assets/') || lower.includes('/assets/');
    const hasModelExt = MODEL_EXTENSIONS.some(ext => lower.endsWith(ext));
    const hasAssetExt = hasModelExt ||
        lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.tex') ||
        lower.endsWith('.mat') || lower.endsWith('.wav') || lower.endsWith('.ogg') ||
        lower.endsWith('.unity') || lower.endsWith('.prefab') || lower.endsWith('.asset');

    if (!isPath && !hasAssetExt) return;

    // Clean up garbage prefix/suffix characters sometimes attached
    const cleaned = str.replace(/^[\x00-\x1F\s]+|[\x00-\x1F\s]+$/g, '').trim();
    if (cleaned.length < MIN_STR_LEN(cleaned)) return;
    if (seenNames.has(cleaned)) return;

    seenNames.add(cleaned);
    const assetType = classifyAsset(cleaned);

    self.postMessage({
        type: 'LOG',
        data: `FOUND ASSET: ${cleaned}`,
        logType: 'data'
    });

    // Emit generic asset event for all
    self.postMessage({
        type: 'ASSET_FOUND_META',
        data: { name: cleaned, offset: absOffset, assetType, isCab: false }
    });

    // Emit dedicated MODEL_FOUND for 3D assets so the UI can count and list them separately
    if (assetType === ASSET_TYPES.MODEL) {
        self.postMessage({
            type: 'MODEL_FOUND',
            data: {
                name: cleaned,
                offset: absOffset,
                // Determine if we can attempt a direct OBJ load (only for .obj files found loose)
                viewable: lower.endsWith('.obj'),
                ext: getExt(cleaned)
            }
        });
    }
}

function MIN_STR_LEN(s) {
    // Require longer strings for non-path assets to reduce false positives
    return s.includes('/') ? 5 : 8;
}

function getExt(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

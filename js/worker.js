// js/worker.js — Unity APK extraction worker
// Pure-JS pipeline. Wasm C++ engine (build/parser.js) used if present.

// ── State ──────────────────────────────────────────────────────
let wasmModule = null;
let wasmReady  = false;
let modelCount = 0;
let assetCount = 0;
let texCount   = 0;
const seenKeys = new Set();

// ── Logging helpers ────────────────────────────────────────────
function log(msg, logType = 'info') { postMessage({ type: 'LOG', data: msg, logType }); }
function progress(p)               { postMessage({ type: 'PROGRESS', data: p }); }

self.onerror = (message) => { log(`Worker error: ${message}`, 'error'); return true; };

// ── Wasm engine (optional) ────────────────────────────────────
self.Module = {
    locateFile(path) { return '../build/' + path; },
    onRuntimeInitialized() {
        wasmModule = self.Module;
        wasmReady  = true;
        log('Wasm engine ready (C++ bindings loaded).', 'success');
    },
    print:    (msg) => log(`[C++] ${msg}`, 'system'),
    printErr: (msg) => log(`[C++ ERR] ${msg}`, 'error'),
};

self.onFileExtracted = function(nodeName, bufferPtr, size, isSerializedContainer) {
    if (!wasmModule || size <= 0) return;
    const heapSlice = new Uint8Array(self.HEAPU8.buffer, bufferPtr, size);
    const nodeBuf   = new Uint8Array(size);
    nodeBuf.set(heapSlice);
    const shortName = nodeName.split('/').pop() || nodeName;
    log(`Node: ${shortName} (${size} bytes)`, 'system');
    assetCount++;
    postMessage({ type: 'ASSET_FOUND_META', data: { name: nodeName, offset: 0, assetType: 'bundle' } });
    if (isSerializedContainer) {
        try { parseSerializedFile(nodeBuf, nodeName); }
        catch(e) { /* non-mesh nodes silent */ }
    }
};

try {
    importScripts('../build/parser.js');
} catch(e) {
    log('Wasm engine not found — using pure-JS fallback.', 'error');
}

// ── ZIP constants ──────────────────────────────────────────────
const ZIP_LOCAL_SIG   = 0x04034B50;
const ZIP_CENTRAL_SIG = 0x02014B50;
const ZIP_EOCD_SIG    = 0x06054B50;

// ── Main message handler ───────────────────────────────────────
self.onmessage = async function(e) {
    if (e.data.type !== 'PROCESS_FILE') return;
    const file = e.data.file;

    modelCount = 0; assetCount = 0; texCount = 0; seenKeys.clear();
    log(`Mounting: ${file.name}`, 'success');
    log(`Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    progress(3);

    try {
        const buf = await file.arrayBuffer();
        const u8  = new Uint8Array(buf);
        progress(15);

        let entries = [];
        try {
            entries = parseZipCD(u8);
            log(`ZIP: ${entries.length} entries indexed.`, 'system');
        } catch(ex) {
            log(`ZIP parse: ${ex.message} — raw scan fallback.`, 'error');
        }

        if (entries.length > 0) {
            await processBundles(u8, buf, entries);
        } else {
            await rawScan(u8);
        }

        progress(100);
        postMessage({ type: 'SCAN_COMPLETE', data: { modelCount, assetCount, texCount } });
        log(`Complete: ${modelCount} mesh(es), ${texCount} texture(s), ${assetCount} assets total.`, 'success');

    } catch(err) {
        log(`Fatal: ${err.message}`, 'error');
    }
};

// ── ZIP Central Directory parser ──────────────────────────────
function parseZipCD(u8) {
    const dv  = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = u8.length;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
        if (dv.getUint32(i, true) === ZIP_EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No EOCD signature');
    const cdOff  = dv.getUint32(eocd + 16, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const entries = [];
    let p = cdOff;
    while (p < cdOff + cdSize && p + 46 <= len) {
        if (dv.getUint32(p, true) !== ZIP_CENTRAL_SIG) break;
        const method     = dv.getUint16(p + 10, true);
        const cSize      = dv.getUint32(p + 20, true);
        const uSize      = dv.getUint32(p + 24, true);
        const fnLen      = dv.getUint16(p + 28, true);
        const extraLen   = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOff   = dv.getUint32(p + 42, true);
        const name       = new TextDecoder().decode(u8.slice(p + 46, p + 46 + fnLen));
        if (!name.endsWith('/')) entries.push({ name, method, cSize, uSize, localOff });
        p += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
}

function extractEntry(u8, entry) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p  = entry.localOff;
    if (dv.getUint32(p, true) !== ZIP_LOCAL_SIG) return null;
    const fnLen    = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start    = p + 30 + fnLen + extraLen;
    if (entry.method === 0) return u8.slice(start, start + entry.cSize);
    return null;
}

async function extractEntryAsync(u8, entry) {
    const sync = extractEntry(u8, entry);
    if (sync) return sync;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p  = entry.localOff;
    const fnLen    = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start    = p + 30 + fnLen + extraLen;
    const comp     = u8.slice(start, start + entry.cSize);
    if (typeof DecompressionStream === 'undefined') return null;
    try {
        const ds = new DecompressionStream('deflate-raw');
        const w  = ds.writable.getWriter();
        const r  = ds.readable.getReader();
        w.write(comp); w.close();
        const chunks = []; let total = 0;
        while (true) {
            const { done, value } = await r.read();
            if (done) break;
            chunks.push(value); total += value.length;
        }
        const out = new Uint8Array(total); let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    } catch(ex) { return null; }
}

function isUnityFS(u8) {
    return u8.length >= 7
        && u8[0] === 0x55 && u8[1] === 0x6E && u8[2] === 0x69
        && u8[3] === 0x74 && u8[4] === 0x79 && u8[5] === 0x46 && u8[6] === 0x53;
}

// Heuristic detection for a bare Unity SerializedFile (no UnityFS wrapper).
// Validates: version in 9–22, sane metaSize, and dataOffset within buffer.
function isSerializedFile(u8) {
    if (u8.length < 20) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // Bytes 0-3: metadataSize (BE uint32)
    // Bytes 4-7: fileSize (BE uint32) [older] or first 4 of int64 (newer)
    // Bytes 8-11: version (BE uint32)
    const metaSize = dv.getUint32(0, false);
    const version  = dv.getUint32(8, false);
    if (version < 9 || version > 22) return false;
    if (metaSize <= 0 || metaSize > 10_000_000) return false;
    // For version >=22 dataOffset is at bytes 16-23 (int64); low word at 20.
    // For version <22 dataOffset is at bytes 12-15 (uint32).
    const dataOffset = version >= 22
        ? dv.getUint32(20, false)   // low 32 bits of int64
        : dv.getUint32(12, false);
    if (dataOffset > u8.length) return false;
    return true;
}

// ── Bundle processor ───────────────────────────────────────────
// ZIP-aware: extracts every non-trivial entry and probes for UnityFS/SerializedFile.
// The old isBundleCandidate name-filter is gone — APK split packs use hash names.
async function processBundles(u8, rawBuf, entries) {
    for (const e of entries) {
        postMessage({ type: 'ASSET_FOUND_META', data: { name: e.name, offset: e.localOff, assetType: 'file' } });
        assetCount++;
    }

    // Skip extensions that are definitively non-Unity binary data.
    const SKIP_EXT = /\.(dex|xml|png|jpg|jpeg|gif|webp|so|txt|json|ini|cfg|proto|kotlin_module|MF|SF|RSA|DSA|properties|gradle|class|html|css|js|arsc)$/i;
    const candidates = entries.filter(e => !SKIP_EXT.test(e.name));
    log(`${candidates.length} candidate entries to probe for Unity data.`, 'system');

    for (let i = 0; i < candidates.length; i++) {
        progress(15 + Math.floor((i / candidates.length) * 82));
        const entry = candidates[i];
        const short = lastName(entry.name);
        try {
            const data = await extractEntryAsync(u8, entry);
            if (!data || data.length < 32) continue;

            if (isUnityFS(data)) {
                log(`UnityFS bundle: ${short}`, 'system');
                parseUnityFSBundle(data, entry.name);
            } else if (isSerializedFile(data)) {
                log(`Serialized file: ${short}`, 'system');
                parseSerializedFile(data, entry.name);
            }
        } catch(err) {
            log(`[${short}] ${err.message}`, 'error');
        }
    }
}

// ── Raw scan fallback ──────────────────────────────────────────
async function rawScan(u8) {
    log('Raw binary scan for UnityFS blocks…', 'system');
    const offsets = [];
    for (let i = 0; i < u8.length - 7; i++) {
        if (isUnityFS(u8.slice(i, i + 7))) offsets.push(i);
    }
    log(`${offsets.length} UnityFS block(s).`, 'system');
    for (let i = 0; i < offsets.length; i++) {
        progress(15 + Math.floor((i / offsets.length) * 82));
        try { parseUnityFSBundle(u8.slice(offsets[i]), `raw_${i}`); } catch(ex) {}
    }
}

function lastName(path) {
    const p = path.split('/'); const s = p[p.length - 1];
    return s.length > 22 ? s.slice(0, 10) + '…' + s.slice(-8) : s;
}

// ══════════════════════════════════════════════════════════════
// PURE-JS PIPELINE
// ══════════════════════════════════════════════════════════════

const COMP_NONE   = 0;
const COMP_LZ4    = 2;
const COMP_LZ4HC  = 3;
const CLASS_MESH  = 43;
const CLASS_TEX2D = 28;

function a4(n) { return (n + 3) & ~3; }

// ── LZ4 block decompressor ────────────────────────────────────
function lz4Decomp(src, maxOut) {
    const dst = new Uint8Array(maxOut);
    let sPos = 0, dPos = 0;
    while (sPos < src.length && dPos < dst.length) {
        const tok = src[sPos++];
        let litLen = tok >> 4, matchLen = tok & 0xF;
        if (litLen === 15) {
            let x;
            do { x = src[sPos++]; litLen += x; } while (x === 255 && sPos < src.length);
        }
        const litCopy = Math.min(litLen, dst.length - dPos, src.length - sPos);
        for (let i = 0; i < litCopy; i++) dst[dPos++] = src[sPos++];
        if (sPos >= src.length) break;
        const mOff = src[sPos] | (src[sPos + 1] << 8); sPos += 2;
        if (mOff === 0) break;
        if (matchLen === 15) {
            let x;
            do { x = src[sPos++]; matchLen += x; } while (x === 255 && sPos < src.length);
        }
        matchLen += 4;
        let mPos = dPos - mOff;
        if (mPos < 0) break;
        const mEnd = Math.min(dPos + matchLen, dst.length);
        while (dPos < mEnd) dst[dPos++] = dst[mPos++];
    }
    return dst.slice(0, dPos);
}

function decomp(src, comp, uSize) {
    if (comp === COMP_NONE) return src;
    if (comp === COMP_LZ4 || comp === COMP_LZ4HC) {
        try { return lz4Decomp(src, uSize); }
        catch(e) { log(`LZ4: ${e.message}`, 'error'); return null; }
    }
    return null;
}

// ── UnityFS bundle parser ─────────────────────────────────────
// Handles Unity format 6 (≥2019.4) and format 7 (≥2020.3) headers.
// Header layout (all big-endian after the magic):
//   [0..6]  "UnityFS" magic
//   [7]     0x00 null terminator
//   [8..11] format version (int32 BE)   — we call this 'fmtVer'
//   then: null-terminated unity version string
//   then: null-terminated minimum revision string
//   then: bundle size int64 (8 bytes)
//   then: compressed block-info size   uint32 (4 bytes)
//   then: uncompressed block-info size uint32 (4 bytes)
//   then: flags                        uint32 (4 bytes)
// Block-info layout (decompressed):
//   [0..15] MD5 hash (16 bytes, skip)
//   blockCount: uint32
//   blocks[]:  uSize(uint32) + cSize(uint32) + flags(uint16)  = 10 bytes each
//   nodeCount: uint32
//   nodes[]:   offset(int64) + size(int64) + flags(uint32) + path(null-str)
function parseUnityFSBundle(u8, sourceName) {
    if (!u8 || u8.length < 48) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // Skip "UnityFS\0" (8 bytes)
    let p = 8;
    // Format version (int32 BE)
    const fmtVer = dv.getInt32(p, false); p += 4;
    // Unity version string (null-terminated)
    while (p < u8.length && u8[p] !== 0) p++; p++;
    // Minimum revision string (null-terminated)
    while (p < u8.length && u8[p] !== 0) p++; p++;
    // Bundle size int64 BE (8 bytes) — skip, we don't need it
    p += 8;

    if (p + 12 > u8.length) return;
    const ciSize = dv.getUint32(p, false); p += 4;   // compressed block-info size
    const uiSize = dv.getUint32(p, false); p += 4;   // uncompressed block-info size
    const flags  = dv.getUint32(p, false); p += 4;

    const dataStart  = p;
    const compression = flags & 0x3F;
    const blocksAtEnd = (flags & 0x80) !== 0;

    // Locate the compressed block-info bytes
    let biBytes;
    if (blocksAtEnd) {
        const biOff = u8.length - ciSize;
        if (biOff < dataStart || biOff + ciSize > u8.length) return;
        biBytes = u8.slice(biOff, biOff + ciSize);
    } else {
        if (dataStart + ciSize > u8.length) return;
        biBytes = u8.slice(dataStart, dataStart + ciSize);
    }

    const bi = decomp(biBytes, compression, uiSize);
    if (!bi || bi.length < 20) return;

    const biDv = new DataView(bi.buffer, bi.byteOffset, bi.byteLength);
    // Skip 16-byte MD5 hash
    let bp = 16;

    if (bp + 4 > bi.length) return;
    const blockCount = biDv.getUint32(bp, false); bp += 4;
    if (blockCount > 100_000) return;

    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
        if (bp + 10 > bi.length) return;
        const uSz    = biDv.getUint32(bp, false); bp += 4;
        const cSz    = biDv.getUint32(bp, false); bp += 4;
        const bFlags = biDv.getUint16(bp, false); bp += 2;
        blocks.push({ uSz, cSz, comp: bFlags & 0x3F });
    }

    if (bp + 4 > bi.length) return;
    const nodeCount = biDv.getUint32(bp, false); bp += 4;
    if (nodeCount > 100_000) return;

    // Node entry: offset(int64) + size(int64) + flags(uint32) + path(null-str)
    // We only need the low 32 bits of offset and size (files < 4 GB).
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        if (bp + 20 > bi.length) return;
        // offset int64 BE: hi=uint32, lo=uint32
        bp += 4;                                              // skip hi word
        const offLo = biDv.getUint32(bp, false); bp += 4;
        // size int64 BE: hi=uint32, lo=uint32
        bp += 4;                                              // skip hi word
        const szLo  = biDv.getUint32(bp, false); bp += 4;
        // flags uint32
        bp += 4;
        // null-terminated path
        const ns = bp;
        while (bp < bi.length && bi[bp] !== 0) bp++;
        const nodeName = new TextDecoder().decode(bi.slice(ns, bp));
        bp++; // consume null terminator
        nodes.push({ offset: offLo, size: szLo, name: nodeName });
    }

    const totalU = blocks.reduce((a, b) => a + b.uSz, 0);
    if (totalU === 0 || totalU > 512 * 1024 * 1024) return;

    // Decompress all data blocks into one contiguous buffer
    const fullData = new Uint8Array(totalU);
    let wPos = 0;
    let rPos = blocksAtEnd ? dataStart : dataStart + ciSize;

    for (const block of blocks) {
        if (rPos + block.cSz > u8.length) break;
        const dec = decomp(u8.slice(rPos, rPos + block.cSz), block.comp, block.uSz);
        if (dec) {
            const copyLen = Math.min(dec.length, block.uSz, fullData.length - wPos);
            fullData.set(dec.slice(0, copyLen), wPos);
        }
        wPos += block.uSz;
        rPos += block.cSz;
    }

    for (const node of nodes) {
        if (node.size < 32 || node.offset + node.size > fullData.length) continue;
        try {
            parseSerializedFile(
                fullData.slice(node.offset, node.offset + node.size),
                node.name || sourceName
            );
        } catch(e) { /* silent: non-serialized nodes (e.g. raw resource files) */ }
    }
}

// ── SerializedFile parser ─────────────────────────────────────
// Supports Unity serialized file versions 9–22 (Unity 5.x through 2022.x).
//
// Header layouts (all big-endian):
//   v9–21:
//     metadataSize: uint32
//     fileSize:     uint32
//     version:      uint32
//     dataOffset:   uint32
//     endian:       uint8
//     [3 reserved bytes — only present in v9+]
//
//   v22:
//     metadataSize: uint32
//     fileSize:     int64   ← 8 bytes, not 4!
//     version:      uint32
//     dataOffset:   int64   ← 8 bytes, not 4!
//     endian:       uint8
//     [3 reserved bytes]
//
// FIX A: read int64 fileSize/dataOffset for version >= 22.
function parseSerializedFile(u8, sourceName) {
    if (u8.length < 32) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0;

    /* metadataSize */ p += 4;

    let version, dataOffset;
    if (dv.getUint32(8, false) >= 22) {
        // v22+: fileSize is int64 (8 bytes), dataOffset is int64 (8 bytes)
        // Layout: metaSize(4) fileSize(8) version(4) dataOffset(8) endian(1) reserved(3)
        /* fileSize hi */ p += 4;
        /* fileSize lo */ p += 4;
        version    = dv.getUint32(p, false); p += 4;
        /* dataOffset hi */ p += 4;
        dataOffset = dv.getUint32(p, false); p += 4;  // low 32 bits is sufficient (< 4 GB)
        /* endian + 3 reserved */ p += 4;
    } else {
        // v9–21: fileSize(4) version(4) dataOffset(4) endian(1) reserved(3)
        /* fileSize */ p += 4;
        version    = dv.getUint32(p, false); p += 4;
        dataOffset = dv.getUint32(p, false); p += 4;
        /* endian + 3 reserved */ p += 4;
    }

    if (version < 9 || version > 22) return;
    if (dataOffset === 0 || dataOffset >= u8.length) return;

    // Unity version string (null-terminated) — present in v9+
    while (p < u8.length && u8[p] !== 0) p++; p++;

    if (version >= 13) {
        p += 4;                    // platform (BuildTarget int32)
        if (version >= 15) p += 1; // enableTypeTree (bool)
    }

    if (p + 4 > u8.length) return;
    const typeCount = dv.getInt32(p, false); p += 4;
    if (typeCount < 0 || typeCount > 65535) return;

    const classIds = [];
    for (let t = 0; t < typeCount; t++) {
        if (p + 4 > u8.length) return;
        const cid = dv.getInt32(p, false); p += 4;
        classIds.push(cid);
        if (version >= 16) p += 3;  // isStrippedType(bool) + scriptTypeIndex(int16)
        if (version >= 13) {
            // scriptID hash (16 bytes) only for MonoBehaviour types
            if ((version >= 16 && cid === 114) || (version < 16 && cid < 0)) p += 16;
            p += 16; // typeHash (16 bytes, always present in v13+)
        }
        if (version >= 15) {
            // TypeTree nodes
            if (p + 8 > u8.length) return;
            const nc = dv.getInt32(p, false); p += 4;
            const sb = dv.getInt32(p, false); p += 4;
            if (nc < 0 || nc > 200_000 || sb < 0 || sb > 5_000_000) return;
            p += nc * 24 + sb;
            if (version >= 21) {
                if (p + 4 > u8.length) return;
                const td = dv.getInt32(p, false); p += 4;
                p += td * 4;
            }
        }
    }

    if (p + 4 > u8.length) return;
    const objCount = dv.getInt32(p, false); p += 4;
    if (objCount < 0 || objCount > 200_000) return;

    for (let i = 0; i < objCount; i++) {
        // Object table entry alignment: 4 bytes in v14+
        if (version >= 14) {
            p = a4(p);
            if (p + 8 > u8.length) return;
            p += 8; // pathID (int64)
        } else {
            if (p + 4 > u8.length) return;
            p += 4; // pathID (int32)
        }
        if (p + 12 > u8.length) return;
        const byteStart = dv.getUint32(p, false); p += 4;
        const byteSize  = dv.getUint32(p, false); p += 4;
        const typeIdx   = dv.getInt32(p, false);  p += 4;
        if (version < 16) { if (p + 2 > u8.length) return; p += 2; } // classID (int16)

        const classId = classIds[typeIdx] ?? -1;
        const abs = dataOffset + byteStart;
        if (abs + byteSize > u8.length) continue;

        if (classId === CLASS_MESH) {
            extractMesh(u8.slice(abs, abs + byteSize), sourceName);
        } else if (classId === CLASS_TEX2D) {
            extractTexture(u8.slice(abs, abs + byteSize), sourceName, version);
        }
    }
}

// ── Mesh extractor ────────────────────────────────────────────
// Unity Mesh binary layout (version-independent fields we need):
//   name:            string (int32 len + bytes, align4)
//   bounds:          AABB = 6 floats = 24 bytes
//   subMeshCount:    int32
//   subMeshes[]:     firstByte(u32)+indexCount(u32)+topology(i32)+baseVertex(u32)
//                    +firstVertex(u32)+vertexCount(u32)+localAABB(6f) = 48 bytes each
//   blendShapes:     BlendShapeData (see skipBlendShapes)
//   indexBuffer:     byte array (int32 len + bytes, align4)
//   skin:            BoneWeight4[] (int32 count, each 32 bytes)
//   bindPose:        Matrix4x4[] (int32 count, each 64 bytes)
//   vertexCount:     uint32
//   channelCount:    uint32
//   channels[]:      stream(u8)+offset(u8)+format(u8)+dimension(u8) each
//   streamCount:     uint32
//   streams[]:       offset(u32)+stride(u32)+dividerOp(u8)+frequency(u16)+pad(u8) = 12 bytes each
//   vertexData:      byte array (int32 len + bytes)
//
// FIX B: blend shape NAME is a length-prefixed string, not 2 fixed bytes.
// FIX C: BlendShapeVertex is 40 bytes (pos+norm+tan+idx), not 4.
// FIX D: StreamInfo is 12 bytes per entry, not 16.
function extractMesh(u8, sourceName) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        // Name
        if (p + 4 > u8.length) return;
        const nLen = dv.getInt32(p, false); p += 4;
        if (nLen < 0 || nLen > 4096 || p + nLen > u8.length) return;
        let name = new TextDecoder().decode(u8.slice(p, p + nLen)).replace(/\0/g, '').trim();
        p += nLen; p = a4(p);
        if (!name) name = `Mesh_${modelCount + 1}`;

        const key = `${sourceName}||${name}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        // Bounds (AABB = centre vec3 + extent vec3 = 24 bytes)
        p += 24;

        // SubMeshes
        if (p + 4 > u8.length) return;
        const smCount = dv.getInt32(p, false); p += 4;
        if (smCount < 0 || smCount > 8192) return;
        const subMeshes = [];
        for (let i = 0; i < smCount; i++) {
            // firstByte(4) indexCount(4) topology(4) baseVertex(4) firstVertex(4) vertexCount(4) localAABB(24)
            if (p + 48 > u8.length) return;
            const firstByte  = dv.getUint32(p,      false);
            const indexCount = dv.getUint32(p +  4, false);
            const topology   = dv.getInt32 (p +  8, false);
            // skip baseVertex(4) + firstVertex(4) + vertexCount(4) + localAABB(24) = 36 bytes
            p += 48;
            subMeshes.push({ firstByte, indexCount, topology });
        }

        // ── BlendShapeData ────────────────────────────────────
        // FIX B: MeshBlendShape[] — each has 4+4+1+1 = 10 bytes + aligned string for name
        if (p + 4 > u8.length) return;
        const bsCount = dv.getInt32(p, false); p += 4;
        if (bsCount < 0 || bsCount > 8192) return;
        for (let i = 0; i < bsCount; i++) {
            // firstVertex(u32) + vertexCount(u32) + hasNormals(bool) + hasTangents(bool) = 10 bytes
            if (p + 10 > u8.length) return;
            p += 8;            // firstVertex + vertexCount
            p += 2;            // hasNormals + hasTangents
            p = a4(p);         // align to 4 bytes
            // name: int32 len + bytes, align4
            if (p + 4 > u8.length) return;
            const snLen = dv.getInt32(p, false); p += 4;
            if (snLen < 0 || snLen > 4096 || p + snLen > u8.length) return;
            p += snLen; p = a4(p);
        }

        // BlendShapeChannel[] — name(string) + hash(u32) + frameIndex(i32) + frameCount(i32)
        if (p + 4 > u8.length) return;
        const bscCount = dv.getInt32(p, false); p += 4;
        if (bscCount < 0 || bscCount > 8192) return;
        for (let i = 0; i < bscCount; i++) {
            if (p + 4 > u8.length) return;
            const cnLen = dv.getInt32(p, false); p += 4;
            if (cnLen < 0 || cnLen > 4096 || p + cnLen > u8.length) return;
            p += cnLen; p = a4(p);
            p += 12; // hash(u32) + frameIndex(i32) + frameCount(i32)
        }

        // FIX C: BlendShapeVertex = pos(12) + normal(12) + tangent(12) + index(4) = 40 bytes each
        if (p + 4 > u8.length) return;
        const bsfCount = dv.getInt32(p, false); p += 4;
        if (bsfCount < 0 || bsfCount > 1_000_000) return;
        p += bsfCount * 40;  // was incorrectly * 4

        // Index buffer
        if (p + 4 > u8.length) return;
        const ibLen = dv.getInt32(p, false); p += 4;
        if (ibLen < 0 || ibLen > 100_000_000 || p + ibLen > u8.length) return;
        const indexBuf = u8.slice(p, p + ibLen);
        p += ibLen; p = a4(p);

        // Skin (BoneWeight4: 4 weights f32 + 4 indices i32 = 32 bytes each)
        if (p + 4 > u8.length) return;
        const skinCount = dv.getInt32(p, false); p += 4;
        if (skinCount < 0 || skinCount > 2_000_000) return;
        p += skinCount * 32;

        // BindPoses (Matrix4x4 = 64 bytes each)
        if (p + 4 > u8.length) return;
        const bpCount = dv.getInt32(p, false); p += 4;
        if (bpCount < 0 || bpCount > 4096) return;
        p += bpCount * 64;

        // Vertex data header
        if (p + 8 > u8.length) return;
        const vertexCount  = dv.getUint32(p, false); p += 4;
        const channelCount = dv.getUint32(p, false); p += 4;
        if (vertexCount === 0 || vertexCount > 5_000_000 || channelCount > 64) return;

        // Channels: stream(u8) + offset(u8) + format(u8) + dimension(u8) = 4 bytes each
        const channels = [];
        for (let i = 0; i < channelCount; i++) {
            if (p + 4 > u8.length) return;
            channels.push({
                stream:    u8[p++],
                offset:    u8[p++],
                format:    u8[p++],
                dimension: u8[p++] & 0xF
            });
        }

        // FIX D: StreamInfo = offset(u32) + stride(u32) + dividerOp(u8) + frequency(u16) + pad(u8)
        //        = 12 bytes each.  Old code read 16 bytes per stream, misaligning everything.
        if (p + 4 > u8.length) return;
        const streamCount = dv.getUint32(p, false); p += 4;
        if (streamCount > 16) return;
        const streams = [];
        for (let i = 0; i < streamCount; i++) {
            if (p + 12 > u8.length) return;
            const sOff   = dv.getUint32(p, false); p += 4;
            const stride = dv.getUint32(p, false); p += 4;
            p += 4; // dividerOp(u8) + frequency(u16) + pad(u8)
            streams.push({ offset: sOff, stride });
        }

        // Vertex buffer
        if (p + 4 > u8.length) return;
        const vbLen = dv.getInt32(p, false); p += 4;
        if (vbLen < 0 || vbLen > 500_000_000 || p + vbLen > u8.length) return;
        const vBuf = u8.slice(p, p + vbLen);
        const vbDv = new DataView(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength);

        // Attribute reader — resolves a vertex attribute for a given vertex index
        function readAttr(chanIdx, vtxIdx) {
            if (chanIdx >= channels.length) return null;
            const ch = channels[chanIdx];
            if (ch.dimension === 0 || ch.stream >= streams.length) return null;
            const st  = streams[ch.stream];
            const bpe = fmtBpe(ch.format);
            const off = st.offset + vtxIdx * st.stride + ch.offset;
            if (off + ch.dimension * bpe > vBuf.length) return null;
            const out = [];
            for (let d = 0; d < ch.dimension; d++) {
                const o = off + d * bpe;
                if      (ch.format === 0)  out.push(vbDv.getFloat32(o, true));
                else if (ch.format === 1)  out.push(f16(vbDv.getUint16(o, true)));
                else if (ch.format === 2)  out.push(vbDv.getUint8(o) / 255);
                else if (ch.format === 10) out.push(vbDv.getUint16(o, true));
                else if (ch.format === 11) out.push(vbDv.getUint32(o, true));
                else                       out.push(vbDv.getFloat32(o, true));
            }
            return out;
        }

        // Build OBJ
        const lines = [`# ${name}`, `g ${name}`, ``];

        for (let v = 0; v < vertexCount; v++) {
            const pos = readAttr(0, v);
            lines.push(pos && pos.length >= 3
                ? `v ${pos[0].toFixed(6)} ${pos[1].toFixed(6)} ${pos[2].toFixed(6)}`
                : 'v 0 0 0');
        }

        const hasNorm = channels.length > 1 && channels[1].dimension >= 3;
        if (hasNorm) {
            for (let v = 0; v < vertexCount; v++) {
                const n = readAttr(1, v);
                lines.push(n && n.length >= 3
                    ? `vn ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`
                    : 'vn 0 1 0');
            }
        }

        const uvCh = (channels.length > 4 && channels[4].dimension >= 2) ? 4
                   : (channels.length > 2 && channels[2].dimension >= 2) ? 2 : -1;
        const hasUV = uvCh >= 0;
        if (hasUV) {
            for (let v = 0; v < vertexCount; v++) {
                const uv = readAttr(uvCh, v);
                lines.push(uv && uv.length >= 2
                    ? `vt ${uv[0].toFixed(6)} ${uv[1].toFixed(6)}`
                    : 'vt 0 0');
            }
        }

        const totalIdx = subMeshes.reduce((a, s) => a + s.indexCount, 0);
        const use32    = ibLen > 0 && totalIdx > 0 && (ibLen / totalIdx) > 2.5;
        const idxDv    = new DataView(indexBuf.buffer, indexBuf.byteOffset, indexBuf.byteLength);
        const getIdx   = use32
            ? i => idxDv.getUint32(i * 4, true)
            : i => idxDv.getUint16(i * 2, true);
        const idxMax   = use32 ? Math.floor(ibLen / 4) : Math.floor(ibLen / 2);

        for (const sm of subMeshes) {
            if (sm.topology !== 0) continue; // only triangles
            const iStart = Math.floor(sm.firstByte / (use32 ? 4 : 2));
            for (let i = 0; i + 2 < sm.indexCount; i += 3) {
                if (iStart + i + 2 >= idxMax) break;
                const a = getIdx(iStart + i)     + 1;
                const b = getIdx(iStart + i + 1) + 1;
                const c = getIdx(iStart + i + 2) + 1;
                if      (hasNorm && hasUV) lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
                else if (hasUV)            lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
                else if (hasNorm)          lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
                else                       lines.push(`f ${a} ${b} ${c}`);
            }
        }

        const faceCount = lines.filter(l => l.startsWith('f ')).length;
        if (faceCount === 0 || vertexCount < 3) return;

        modelCount++; assetCount++;
        log(`MESH: ${name} — ${vertexCount}v / ${faceCount}f`, 'success');
        postMessage({
            type: 'MODEL_FOUND',
            data: { name, sourceName, vertexCount, faceCount, objText: lines.join('\n') }
        });

    } catch(e) { /* silent: corrupted or unsupported mesh */ }
}

// ── Texture2D extractor ───────────────────────────────────────
// Parses enough of the Texture2D binary to extract name, dimensions,
// texture format, and the raw pixel data bytes. Ships the raw data
// to the UI as a TEXTURE_FOUND message so it can be displayed/saved.
//
// Texture2D layout (Unity 2019–2022, big-endian header fields):
//   name:           string
//   forcedFallback: bool + align
//   width:          int32
//   height:         int32
//   completeSize:   int32
//   textureFormat:  int32  (enum: 1=Alpha8, 2=ARGB4444, 3=RGB24, 4=RGBA32,
//                           5=ARGB32, 7=RGB565, 9=R16, 10=DXT1, 12=DXT5,
//                           13=RGBA4444, 14=BGRA32, 15=RHalf, 16=RGHalf,
//                           17=RGBAHalf, 18=RFloat, 19=RGFloat, 20=RGBAFloat,
//                           21=YUY2, 22=RGB9e5, 24=BC4, 25=BC5, 26=BC6H,
//                           27=BC7, 29=DXT1Crunched, 30=DXT5Crunched,
//                           34=PVRTC_RGB2, 35=PVRTC_RGBA2, 36=PVRTC_RGB4,
//                           37=PVRTC_RGBA4, 38=ETC_RGB4, 39=ATC_RGB4,
//                           40=ATC_RGBA8, 45=EAC_R, 46=EAC_R_SIGNED,
//                           47=EAC_RG, 48=EAC_RG_SIGNED, 49=ETC2_RGB,
//                           50=ETC2_RGBA1, 51=ETC2_RGBA8, 52=ASTC_4x4 … 72=ASTC_RGBA_12x12)
//   mipCount:       int32
//   isReadable:     bool + align
//   isPreProcessed: bool + align  (only in some versions)
//   streamingMips:  bool + align
//   streamingPriority: int32
//   imageCount:     int32
//   textureDimension: int32
//   filterMode:     int32
//   aniso:          int32
//   mipBias:        float
//   wrapModeU:      int32
//   wrapModeV:      int32
//   wrapModeW:      int32
//   lightmapFormat: int32
//   colorSpace:     int32
//   platformBlob:   byte array (int32 len + bytes, align4)
//   imageDataSize:  int32
//   imageData:      bytes
//
// We read just enough to get to imageData reliably.
const TEX_FORMAT_NAMES = {
    1:'Alpha8',2:'ARGB4444',3:'RGB24',4:'RGBA32',5:'ARGB32',7:'RGB565',
    9:'R16',10:'DXT1',12:'DXT5',13:'RGBA4444',14:'BGRA32',15:'RHalf',
    16:'RGHalf',17:'RGBAHalf',18:'RFloat',19:'RGFloat',20:'RGBAFloat',
    29:'DXT1Crunched',30:'DXT5Crunched',34:'PVRTC_RGB2',35:'PVRTC_RGBA2',
    36:'PVRTC_RGB4',37:'PVRTC_RGBA4',38:'ETC_RGB4',45:'EAC_R',47:'EAC_RG',
    49:'ETC2_RGB',50:'ETC2_RGBA1',51:'ETC2_RGBA8',
    52:'ASTC_4x4',53:'ASTC_5x5',54:'ASTC_6x6',55:'ASTC_8x8',56:'ASTC_10x10',57:'ASTC_12x12',
    58:'ETC_RGB4_3DS',59:'ETC_RGBA8_3DS',
    62:'ASTC_HDR_4x4',63:'ASTC_HDR_5x5',64:'ASTC_HDR_6x6',65:'ASTC_HDR_8x8',
    66:'ASTC_HDR_10x10',67:'ASTC_HDR_12x12',
    68:'ASTC_RGB_4x4',69:'ASTC_RGB_5x5',70:'ASTC_RGB_6x6',71:'ASTC_RGB_8x8',
    72:'ASTC_RGBA_12x12'
};

function extractTexture(u8, sourceName, sfVersion) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        // Name
        if (p + 4 > u8.length) return;
        const nLen = dv.getInt32(p, false); p += 4;
        if (nLen < 0 || nLen > 4096 || p + nLen > u8.length) return;
        const name = new TextDecoder().decode(u8.slice(p, p + nLen)).replace(/\0/g, '').trim() || `Tex_${texCount + 1}`;
        p += nLen; p = a4(p);

        const texKey = `${sourceName}||${name}`;
        if (seenKeys.has(texKey)) return;
        seenKeys.add(texKey);

        // forcedFallbackFormat (int32) + downloadedMipCount (int32) -- present in 2020+
        // OR just forcedFallbackFormat bool + align in 2019.
        // Safe to skip 4 bytes for the int32 forced-fallback field.
        if (p + 4 > u8.length) return;
        p += 4;                           // forcedFallback / isAlphaChannelOptional
        p = a4(p);

        if (p + 12 > u8.length) return;
        const width         = dv.getInt32(p, false); p += 4;
        const height        = dv.getInt32(p, false); p += 4;
        const completeSize  = dv.getInt32(p, false); p += 4;  // mip0 data size

        if (p + 4 > u8.length) return;
        const texFormat = dv.getInt32(p, false); p += 4;

        if (width <= 0 || width > 16384 || height <= 0 || height > 16384) return;

        const fmtName = TEX_FORMAT_NAMES[texFormat] || `Fmt${texFormat}`;

        // Skip remaining header fields until imageDataSize:
        //   mipCount(4) + isReadable(1+align) + ...streamingPriority(4) + imageCount(4)
        //   + texDimension(4) + filterMode(4) + aniso(4) + mipBias(4)
        //   + wrapModeU(4) + wrapModeV(4) + wrapModeW(4) + lightmapFormat(4) + colorSpace(4)
        // That is 13 fixed int32s = 52 bytes, plus 3 bool+align fields = 3*4 = 12 bytes
        // Then platformBlob array, then imageDataSize, then imageData.
        // Rather than version-picking every sub-field, scan forward for imageDataSize
        // by locating it just before image data. We use a simpler approach:
        // skip the fixed portion and read the platformBlob, then imageDataSize.

        if (p + 4 > u8.length) return;
        /* mipCount */ p += 4;
        /* isReadable: bool stored as int32 in Unity serialization */ p += 4;
        /* ignoreMipmapLimit (2020+): bool */ p += 4;
        /* streamingMipmaps: bool */ p += 4;
        /* streamingMipmapsPriority */ p += 4;
        /* imageCount */ p += 4;
        /* textureDimension */ p += 4;
        // TextureSettings struct: filterMode(4)+aniso(4)+mipBias(4)+wrapU(4)+wrapV(4)+wrapW(4) = 24 bytes
        p += 24;
        /* lightmapFormat */ p += 4;
        /* colorSpace */ p += 4;

        // platformBlob: byte array
        if (p + 4 > u8.length) return;
        const blobLen = dv.getInt32(p, false); p += 4;
        if (blobLen < 0 || blobLen > 1_000_000 || p + blobLen > u8.length) return;
        p += blobLen; p = a4(p);

        // imageDataSize + imageData
        if (p + 4 > u8.length) return;
        const imgDataSize = dv.getInt32(p, false); p += 4;
        if (imgDataSize <= 0 || imgDataSize > 100_000_000 || p + imgDataSize > u8.length) return;

        const imgData = u8.slice(p, p + imgDataSize);

        texCount++; assetCount++;
        log(`TEX: ${name} — ${width}×${height} ${fmtName} (${imgDataSize} bytes)`, 'success');

        // Attempt to convert RGBA32/BGRA32/ARGB32/RGB24 to a data URL for direct preview.
        // Compressed formats (DXT/ETC2/ASTC) are shipped as raw bytes for the UI to save.
        let previewUrl = null;
        if (width * height <= 4096 * 4096) {
            previewUrl = tryMakePreview(imgData, width, height, texFormat);
        }

        postMessage({
            type: 'TEXTURE_FOUND',
            data: {
                name,
                sourceName,
                width,
                height,
                format: fmtName,
                formatId: texFormat,
                rawBytes: imgData,       // Uint8Array — for saving raw
                previewUrl,              // data:image/png base64 if convertible, else null
            }
        });

    } catch(e) { /* silent */ }
}

// Convert uncompressed Unity pixel data to a PNG data URL via OffscreenCanvas.
// Returns a base64 data URL string, or null if conversion isn't possible.
function tryMakePreview(imgData, w, h, texFormat) {
    // Only handle uncompressed formats we can decode in JS.
    // texFormat: 3=RGB24, 4=RGBA32, 5=ARGB32, 14=BGRA32, 7=RGB565, 13=RGBA4444, 2=ARGB4444
    try {
        const pixelCount = w * h;
        const rgba = new Uint8ClampedArray(pixelCount * 4);

        if (texFormat === 4) {
            // RGBA32: direct copy
            rgba.set(imgData.slice(0, pixelCount * 4));
        } else if (texFormat === 3) {
            // RGB24: insert alpha
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4]     = imgData[i * 3];
                rgba[i * 4 + 1] = imgData[i * 3 + 1];
                rgba[i * 4 + 2] = imgData[i * 3 + 2];
                rgba[i * 4 + 3] = 255;
            }
        } else if (texFormat === 5) {
            // ARGB32: reorder A,R,G,B → R,G,B,A
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4]     = imgData[i * 4 + 1];
                rgba[i * 4 + 1] = imgData[i * 4 + 2];
                rgba[i * 4 + 2] = imgData[i * 4 + 3];
                rgba[i * 4 + 3] = imgData[i * 4];
            }
        } else if (texFormat === 14) {
            // BGRA32: reorder B,G,R,A → R,G,B,A
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4]     = imgData[i * 4 + 2];
                rgba[i * 4 + 1] = imgData[i * 4 + 1];
                rgba[i * 4 + 2] = imgData[i * 4];
                rgba[i * 4 + 3] = imgData[i * 4 + 3];
            }
        } else if (texFormat === 7) {
            // RGB565: 16-bit packed, little-endian
            for (let i = 0; i < pixelCount; i++) {
                const px = imgData[i * 2] | (imgData[i * 2 + 1] << 8);
                rgba[i * 4]     = ((px >> 11) & 0x1F) * 255 / 31;
                rgba[i * 4 + 1] = ((px >>  5) & 0x3F) * 255 / 63;
                rgba[i * 4 + 2] = ( px        & 0x1F) * 255 / 31;
                rgba[i * 4 + 3] = 255;
            }
        } else if (texFormat === 13) {
            // RGBA4444
            for (let i = 0; i < pixelCount; i++) {
                const px = imgData[i * 2] | (imgData[i * 2 + 1] << 8);
                rgba[i * 4]     = ((px >> 12) & 0xF) * 17;
                rgba[i * 4 + 1] = ((px >>  8) & 0xF) * 17;
                rgba[i * 4 + 2] = ((px >>  4) & 0xF) * 17;
                rgba[i * 4 + 3] = ( px        & 0xF) * 17;
            }
        } else if (texFormat === 2) {
            // ARGB4444
            for (let i = 0; i < pixelCount; i++) {
                const px = imgData[i * 2] | (imgData[i * 2 + 1] << 8);
                rgba[i * 4]     = ((px >>  8) & 0xF) * 17;
                rgba[i * 4 + 1] = ((px >>  4) & 0xF) * 17;
                rgba[i * 4 + 2] = ( px        & 0xF) * 17;
                rgba[i * 4 + 3] = ((px >> 12) & 0xF) * 17;
            }
        } else {
            return null; // compressed format — UI must handle raw bytes
        }

        // Flip Y — Unity textures are stored bottom-up
        const flipped = new Uint8ClampedArray(pixelCount * 4);
        const rowBytes = w * 4;
        for (let row = 0; row < h; row++) {
            flipped.set(rgba.slice((h - 1 - row) * rowBytes, (h - row) * rowBytes), row * rowBytes);
        }

        if (typeof OffscreenCanvas === 'undefined') return null;
        const oc  = new OffscreenCanvas(w, h);
        const ctx = oc.getContext('2d');
        ctx.putImageData(new ImageData(flipped, w, h), 0, 0);
        // We can't use toDataURL in a worker, so return the raw RGBA instead.
        // The main thread can render it from imageData transferred via MODEL_FOUND.
        // Return null here; UI will use rawBytes for compressed, ImageData for uncompressed.
        return null; // OffscreenCanvas.convertToBlob is async — skip for now
    } catch(e) {
        return null;
    }
}

// ── Vertex format helpers ─────────────────────────────────────
function fmtBpe(f) {
    // bytes per element for each Unity VertexAttributeFormat
    return f === 0 ? 4   // Float32
         : f === 1 ? 2   // Float16
         : f === 2 ? 1   // UNorm8
         : f === 3 ? 1   // SNorm8
         : f === 4 ? 2   // UNorm16
         : f === 5 ? 2   // SNorm16
         : f === 6 ? 1   // UInt8
         : f === 7 ? 1   // SInt8
         : f === 8 ? 2   // UInt16
         : f === 9 ? 2   // SInt16
         : f === 10 ? 4  // UInt32
         : f === 11 ? 4  // SInt32
         : 4;
}

function f16(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1F;
    const m =  h        & 0x3FF;
    if (e === 0)  return s * 5.96046e-8 * m;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

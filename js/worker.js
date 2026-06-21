// js/worker.js — Unity APK extraction worker
// Supports Unity 5.x through Unity 6 (UnityFS format 8, SerializedFile version 22)
// Confirmed against binary analysis of split_UnityDataAssetPack.apk (Unity 6000.0.62f1)

// ── State ──────────────────────────────────────────────────────
let wasmModule = null;
let wasmReady  = false;
let modelCount = 0;
let assetCount = 0;
let texCount   = 0;
const seenKeys = new Set();

function log(msg, logType = 'info') { postMessage({ type: 'LOG', data: msg, logType }); }
function progress(p)               { postMessage({ type: 'PROGRESS', data: p }); }
self.onerror = (msg) => { log(`Worker error: ${msg}`, 'error'); return true; };

// ── Wasm (optional) ───────────────────────────────────────────
self.Module = {
    locateFile(path) { return '../build/' + path; },
    onRuntimeInitialized() { wasmModule = self.Module; wasmReady = true; log('Wasm ready.', 'success'); },
    print:    (msg) => log(`[C++] ${msg}`, 'system'),
    printErr: (msg) => log(`[C++ ERR] ${msg}`, 'error'),
};
self.onFileExtracted = function(nodeName, bufferPtr, size, isSerialized) {
    if (!wasmModule || size <= 0) return;
    const buf = new Uint8Array(size);
    buf.set(new Uint8Array(self.HEAPU8.buffer, bufferPtr, size));
    assetCount++;
    postMessage({ type: 'ASSET_FOUND_META', data: { name: nodeName, offset: 0, assetType: 'bundle' } });
    if (isSerialized) { try { parseSerializedFile(buf, nodeName); } catch(e) {} }
};
try { importScripts('../build/parser.js'); } catch(e) { log('Wasm not found — pure-JS mode.', 'error'); }

// ── ZIP ────────────────────────────────────────────────────────
const ZIP_LOCAL_SIG   = 0x04034B50;
const ZIP_CENTRAL_SIG = 0x02014B50;
const ZIP_EOCD_SIG    = 0x06054B50;

self.onmessage = async function(e) {
    if (e.data.type !== 'PROCESS_FILE') return;
    const file = e.data.file;
    modelCount = 0; assetCount = 0; texCount = 0; seenKeys.clear();
    log(`Mounting: ${file.name}`, 'success');
    log(`Size: ${(file.size/1024/1024).toFixed(2)} MB`, 'system');
    progress(3);
    try {
        const buf = await file.arrayBuffer();
        const u8  = new Uint8Array(buf);
        progress(15);
        let entries = [];
        try { entries = parseZipCD(u8); log(`ZIP: ${entries.length} entries.`, 'system'); }
        catch(ex) { log(`ZIP: ${ex.message} — raw scan.`, 'error'); }
        if (entries.length > 0) await processBundles(u8, entries);
        else await rawScan(u8);
        progress(100);
        postMessage({ type: 'SCAN_COMPLETE', data: { modelCount, assetCount, texCount } });
        log(`Done: ${modelCount} mesh(es), ${texCount} tex(s), ${assetCount} total.`, 'success');
    } catch(err) { log(`Fatal: ${err.message}`, 'error'); }
};

function parseZipCD(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = u8.length;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
        if (dv.getUint32(i, true) === ZIP_EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No EOCD');
    const cdOff = dv.getUint32(eocd + 16, true), cdSize = dv.getUint32(eocd + 12, true);
    const entries = []; let p = cdOff;
    while (p < cdOff + cdSize && p + 46 <= len) {
        if (dv.getUint32(p, true) !== ZIP_CENTRAL_SIG) break;
        const method = dv.getUint16(p+10,true), cSize = dv.getUint32(p+20,true);
        const uSize  = dv.getUint32(p+24,true), fnLen = dv.getUint16(p+28,true);
        const xLen   = dv.getUint16(p+30,true), cmLen = dv.getUint16(p+32,true);
        const lOff   = dv.getUint32(p+42,true);
        const name   = new TextDecoder().decode(u8.slice(p+46, p+46+fnLen));
        if (!name.endsWith('/')) entries.push({ name, method, cSize, uSize, localOff: lOff });
        p += 46 + fnLen + xLen + cmLen;
    }
    return entries;
}

function extractEntry(u8, entry) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p  = entry.localOff;
    if (dv.getUint32(p, true) !== ZIP_LOCAL_SIG) return null;
    const fnLen = dv.getUint16(p+26,true), xLen = dv.getUint16(p+28,true);
    const start = p + 30 + fnLen + xLen;
    if (entry.method === 0) return u8.slice(start, start + entry.cSize);
    return null;
}

async function extractEntryAsync(u8, entry) {
    const sync = extractEntry(u8, entry);
    if (sync) return sync;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p  = entry.localOff;
    const fnLen = dv.getUint16(p+26,true), xLen = dv.getUint16(p+28,true);
    const start = p + 30 + fnLen + xLen;
    const comp  = u8.slice(start, start + entry.cSize);
    if (typeof DecompressionStream === 'undefined') return null;
    try {
        const ds = new DecompressionStream('deflate-raw');
        const w = ds.writable.getWriter(), r = ds.readable.getReader();
        w.write(comp); w.close();
        const chunks = []; let total = 0;
        while (true) { const {done,value} = await r.read(); if (done) break; chunks.push(value); total += value.length; }
        const out = new Uint8Array(total); let off = 0;
        for (const c of chunks) { out.set(c,off); off += c.length; }
        return out;
    } catch(ex) { return null; }
}

function isUnityFS(u8) {
    return u8.length >= 7 && u8[0]===0x55 && u8[1]===0x6E && u8[2]===0x69
        && u8[3]===0x74 && u8[4]===0x79 && u8[5]===0x46 && u8[6]===0x53;
}

// Confirmed v22 layout from Termux: zeros at 0-7, version at 8, dataOffset lo at 20
function isSerializedFile(u8) {
    if (u8.length < 40) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = dv.getUint32(8, false);
    if (version < 9 || version > 22) return false;
    if (version === 22) {
        if (dv.getUint32(0,false) !== 0 || dv.getUint32(4,false) !== 0) return false;
        const dataOff = dv.getUint32(20, false);
        return dataOff > 0 && dataOff < u8.length;
    }
    const metaSize = dv.getUint32(0,false), dataOff = dv.getUint32(12,false);
    return metaSize > 0 && metaSize < 10_000_000 && dataOff > 0 && dataOff < u8.length;
}

// Skip .resource (MP4 video confirmed from Termux), and other non-Unity extensions
const SKIP_EXT = /\.(dex|xml|png|jpg|jpeg|gif|webp|so|txt|json|ini|cfg|proto|kotlin_module|MF|SF|RSA|DSA|properties|gradle|class|html|css|arsc|mp4|mov|avi|mp3|ogg|wav|resource)$/i;

async function processBundles(u8, entries) {
    for (const e of entries) {
        postMessage({ type: 'ASSET_FOUND_META', data: { name: e.name, offset: e.localOff, assetType: 'file' } });
        assetCount++;
    }
    const candidates = entries.filter(e => !SKIP_EXT.test(e.name));
    log(`${candidates.length} candidates to probe.`, 'system');
    for (let i = 0; i < candidates.length; i++) {
        progress(15 + Math.floor((i / candidates.length) * 82));
        const entry = candidates[i];
        const short = lastName(entry.name);
        try {
            const data = await extractEntryAsync(u8, entry);
            if (!data || data.length < 32) continue;
            if (isUnityFS(data)) {
                log(`UnityFS: ${short}`, 'system');
                parseUnityFSBundle(data, entry.name);
            } else if (isSerializedFile(data)) {
                log(`SerializedFile: ${short}`, 'system');
                parseSerializedFile(data, entry.name);
            }
        } catch(err) { log(`[${short}] ${err.message}`, 'error'); }
    }
}

async function rawScan(u8) {
    log('Raw scan…', 'system');
    const offs = [];
    for (let i = 0; i < u8.length - 7; i++) if (isUnityFS(u8.slice(i,i+7))) offs.push(i);
    log(`${offs.length} UnityFS block(s).`, 'system');
    for (let i = 0; i < offs.length; i++) {
        progress(15 + Math.floor((i/offs.length)*82));
        try { parseUnityFSBundle(u8.slice(offs[i]), `raw_${i}`); } catch(ex) {}
    }
}

function lastName(path) {
    const s = path.split('/').pop() || path;
    return s.length > 26 ? s.slice(0,10)+'…'+s.slice(-10) : s;
}

// ══════════════════════════════════════════════════════════════
// LZ4 DECOMPRESSOR — fixed boundary handling
// Bug: when litCopy < litLen (dst/src boundary hit), sPos was advancing
// by litLen instead of litCopy, reading past end of source buffer.
// ══════════════════════════════════════════════════════════════
function lz4Decomp(src, maxOut) {
    const dst = new Uint8Array(maxOut);
    let sPos = 0, dPos = 0;
    while (sPos < src.length) {
        if (sPos >= src.length) break;
        const tok = src[sPos++];
        let litLen = tok >> 4;

        // Extended literal length
        if (litLen === 15) {
            let x;
            do {
                if (sPos >= src.length) break;
                x = src[sPos++];
                litLen += x;
            } while (x === 255);
        }

        // Copy literals — advance sPos by actual litLen, not litCopy
        const litEnd = Math.min(sPos + litLen, src.length);
        const dstEnd = Math.min(dPos + litLen, dst.length);
        const litCopy = Math.min(litEnd - sPos, dstEnd - dPos);
        for (let i = 0; i < litCopy; i++) dst[dPos++] = src[sPos++];
        // If litLen > litCopy, skip remaining literal bytes in src
        const litSkip = litLen - litCopy;
        if (litSkip > 0) sPos += litSkip;

        // End of block — no match after last literal sequence
        if (sPos >= src.length) break;

        // Match offset (little-endian uint16)
        if (sPos + 2 > src.length) break;
        const mOff = src[sPos] | (src[sPos+1] << 8); sPos += 2;
        if (mOff === 0) break;

        let matchLen = tok & 0xF;
        if (matchLen === 15) {
            let x;
            do {
                if (sPos >= src.length) break;
                x = src[sPos++];
                matchLen += x;
            } while (x === 255);
        }
        matchLen += 4; // minimum match length

        let mPos = dPos - mOff;
        if (mPos < 0) break; // invalid offset
        const mEnd = Math.min(dPos + matchLen, dst.length);
        // Byte-by-byte copy to handle overlapping matches correctly
        while (dPos < mEnd) dst[dPos++] = dst[mPos++];
    }
    return dst.slice(0, dPos);
}

const COMP_NONE  = 0;
const COMP_LZ4   = 2;
const COMP_LZ4HC = 3;

function decomp(src, comp, uSize) {
    if (comp === COMP_NONE) return src;
    if (comp === COMP_LZ4 || comp === COMP_LZ4HC) {
        try { return lz4Decomp(src, uSize); }
        catch(e) { log(`LZ4 err: ${e.message}`, 'error'); return null; }
    }
    log(`Unsupported compression: ${comp}`, 'error');
    return null;
}

// ══════════════════════════════════════════════════════════════
// UnityFS BUNDLE PARSER
// Confirmed header (from Termux, Unity 6000.0.62f1, format version 8):
//   "UnityFS\0" (8)
//   format int32 BE (4)      = 8
//   unity ver string + \0    = "5.x.x\0"
//   min rev string + \0      = "6000.0.62f1\0"
//   bundle size uint64 BE (8)
//   ciSize uint32 BE (4)     = compressed blockinfo size
//   uiSize uint32 BE (4)     = uncompressed blockinfo size
//   flags uint32 BE (4)      = 0x243 confirmed
//     bits 0-5: compression = 3 (LZ4HC)
//     bit 6 (0x40): set (blocks+dir combined)
//     bit 7 (0x80): clear (blockinfo NOT at end — at dataStart)
// Decompressed blockinfo:
//   MD5[16]
//   blockCount uint32 BE
//   blocks[]: uSz(4)+cSz(4)+flags(2) = 10 bytes each
//   nodeCount uint32 BE
//   nodes[]: offset int64 BE(8) + size int64 BE(8) + flags uint32(4) + path null-str
// ══════════════════════════════════════════════════════════════
function parseUnityFSBundle(u8, sourceName) {
    if (!u8 || u8.length < 48) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    let p = 8; // skip "UnityFS\0"
    /* fmtVer */ dv.getInt32(p, false); p += 4;
    while (p < u8.length && u8[p] !== 0) p++; p++; // unity ver string
    while (p < u8.length && u8[p] !== 0) p++; p++; // min rev string
    p += 8; // bundle size int64

    if (p + 12 > u8.length) return;
    const ciSize = dv.getUint32(p, false); p += 4;
    const uiSize = dv.getUint32(p, false); p += 4;
    const flags  = dv.getUint32(p, false); p += 4;

    const dataStart   = p;
    const compression = flags & 0x3F;
    const blocksAtEnd = (flags & 0x80) !== 0;

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
    if (!bi || bi.length < 20) {
        log(`Bundle blockinfo decomp failed: ${lastName(sourceName)}`, 'error');
        return;
    }

    const biDv = new DataView(bi.buffer, bi.byteOffset, bi.byteLength);
    let bp = 16; // skip MD5 hash

    if (bp + 4 > bi.length) return;
    const blockCount = biDv.getUint32(bp, false); bp += 4;
    if (blockCount === 0 || blockCount > 100_000) return;

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
    if (nodeCount === 0 || nodeCount > 100_000) return;

    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        if (bp + 20 > bi.length) return;
        bp += 4; const offLo = biDv.getUint32(bp, false); bp += 4; // int64 hi+lo
        bp += 4; const szLo  = biDv.getUint32(bp, false); bp += 4; // int64 hi+lo
        bp += 4; // flags
        const ns = bp;
        while (bp < bi.length && bi[bp] !== 0) bp++;
        const nodeName = new TextDecoder().decode(bi.slice(ns, bp)); bp++;
        nodes.push({ offset: offLo, size: szLo, name: nodeName });
    }

    const totalU = blocks.reduce((a,b) => a+b.uSz, 0);
    if (totalU === 0 || totalU > 512*1024*1024) return;

    const fullData = new Uint8Array(totalU);
    let wPos = 0;
    let rPos = blocksAtEnd ? dataStart : dataStart + ciSize;
    for (const block of blocks) {
        if (rPos + block.cSz > u8.length) break;
        const dec = decomp(u8.slice(rPos, rPos+block.cSz), block.comp, block.uSz);
        if (dec) {
            const n = Math.min(dec.length, block.uSz, fullData.length - wPos);
            fullData.set(dec.slice(0, n), wPos);
        }
        wPos += block.uSz;
        rPos += block.cSz;
    }

    log(`Bundle OK: ${(totalU/1024).toFixed(0)}KB, ${nodeCount} node(s) [${lastName(sourceName)}]`, 'system');

    for (const node of nodes) {
        if (node.size < 32 || node.offset + node.size > fullData.length) continue;
        try {
            parseSerializedFile(
                fullData.slice(node.offset, node.offset + node.size),
                node.name || sourceName
            );
        } catch(e) {}
    }
}

// ══════════════════════════════════════════════════════════════
// SerializedFile PARSER
//
// CONFIRMED from Termux binary analysis of bin/Data files (Unity 6000.0.74f1):
//
// Version 22 header (all big-endian):
//   [0..3]   uint32 = 0  (reserved)
//   [4..7]   uint32 = 0  (reserved)
//   [8..11]  uint32 BE = version (22)
//   [12..15] uint32 = 0  (padding)
//   [16..19] uint32 = 0  (dataOffset hi)
//   [20..23] uint32 BE = dataOffset lo  ← confirmed 0x55=85
//   [24..27] uint32 = 0  (fileSize hi)
//   [28..31] uint32 BE = fileSize lo    ← confirmed 0x26BE8=158696
//   [32]     uint8 = endian (0=LE)
//   [33..35] uint8[3] reserved
//   [36..]   null-terminated unity version string
//   [36+n+1] metadata starts
//
// Version 9-21 header (all big-endian):
//   [0..3]   uint32 BE = metadataSize
//   [4..7]   uint32 BE = fileSize
//   [8..11]  uint32 BE = version
//   [12..15] uint32 BE = dataOffset
//   [16]     uint8 = endian
//   [17..19] uint8[3] reserved
//   [20..]   null-terminated unity version string
//
// CRITICAL FIX: enableTypeTree bool controls whether type tree nc+sb are present.
// When enableTypeTree=0 (false), the nc/sb block is NOT written for each type.
// Previous code always read nc+sb regardless, misaligning every type entry.
// ══════════════════════════════════════════════════════════════
const CLASS_MESH  = 43;
const CLASS_TEX2D = 28;

function a4(n) { return (n+3) & ~3; }

function parseSerializedFile(u8, sourceName) {
    if (u8.length < 40) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    const version = dv.getUint32(8, false);
    if (version < 9 || version > 22) return;

    let dataOffset, endian, p;

    if (version === 22) {
        if (dv.getUint32(0,false) !== 0 || dv.getUint32(4,false) !== 0) return;
        dataOffset = dv.getUint32(20, false); // lo word of int64 at offset 16
        endian     = u8[32];
        p = 36;
        while (p < u8.length && u8[p] !== 0) p++; p++; // unity version string
    } else {
        dataOffset = dv.getUint32(12, false);
        endian     = u8[16];
        p = 20;
        while (p < u8.length && u8[p] !== 0) p++; p++; // unity version string
    }

    if (dataOffset === 0 || dataOffset >= u8.length) return;
    const LE = (endian === 0); // confirmed 0=LE from Termux

    // ── Metadata header fields ─────────────────────────────
    if (version >= 13) {
        if (p + 4 > u8.length) return;
        p += 4; // platform (BuildTarget int32)
    }

    // enableTypeTree: bool (1 byte) — CRITICAL: controls whether type nodes are present
    let enableTypeTree = true;
    if (version >= 15) {
        if (p + 1 > u8.length) return;
        enableTypeTree = (u8[p] !== 0);
        p += 1;
    }

    // ── Type table ─────────────────────────────────────────
    if (p + 4 > u8.length) return;
    const typeCount = dv.getInt32(p, false); p += 4;
    if (typeCount < 0 || typeCount > 65535) return;

    const classIds = [];
    for (let t = 0; t < typeCount; t++) {
        if (p + 4 > u8.length) return;
        const cid = dv.getInt32(p, false); p += 4;
        classIds.push(cid);

        if (version >= 16) {
            // isStrippedType (bool 1 byte) + scriptTypeIndex (int16 2 bytes)
            if (p + 3 > u8.length) return;
            p += 3;
        }

        if (version >= 13) {
            // scriptID hash: only for MonoBehaviour (classID=114 in v16+, negative in v13-15)
            if ((version >= 16 && cid === 114) || (version < 16 && cid < 0)) {
                if (p + 16 > u8.length) return;
                p += 16;
            }
            // typeHash (always present in v13+)
            if (p + 16 > u8.length) return;
            p += 16;
        }

        // Type tree nodes — ONLY present when enableTypeTree is true
        if (version >= 15 && enableTypeTree) {
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
        // When enableTypeTree=false: no nc/sb written — just classID+hashes above
    }

    // ── Object table ───────────────────────────────────────
    if (p + 4 > u8.length) return;
    const objCount = dv.getInt32(p, false); p += 4;
    if (objCount < 0 || objCount > 200_000) return;

    let meshFound = 0, texFound = 0;

    for (let i = 0; i < objCount; i++) {
        // pathID: int64 in v14+ (4-byte aligned), int32 in v13-
        if (version >= 14) {
            p = a4(p);
            if (p + 8 > u8.length) return;
            p += 8;
        } else {
            if (p + 4 > u8.length) return;
            p += 4;
        }

        if (p + 12 > u8.length) return;
        const byteStart = dv.getUint32(p, false); p += 4;
        const byteSize  = dv.getUint32(p, false); p += 4;
        const typeIdx   = dv.getInt32(p, false);  p += 4;
        if (version < 16) {
            if (p + 2 > u8.length) return;
            p += 2; // classID int16
        }

        const classId = classIds[typeIdx] ?? -1;
        const abs     = dataOffset + byteStart;
        if (abs + byteSize > u8.length || byteSize < 4) continue;
        const objData = u8.slice(abs, abs + byteSize);

        if (classId === CLASS_MESH) {
            extractMesh(objData, sourceName, LE);
            meshFound++;
        } else if (classId === CLASS_TEX2D) {
            extractTexture(objData, sourceName, LE);
            texFound++;
        }
    }

    if (meshFound > 0 || texFound > 0) {
        log(`  → ${meshFound} mesh, ${texFound} tex in ${lastName(sourceName)}`, 'system');
    }
}

// ══════════════════════════════════════════════════════════════
// MESH EXTRACTOR
// Unity Mesh binary layout (little-endian object data):
//   name:         string (int32 len + bytes, align4)
//   bounds:       AABB 6 floats = 24 bytes
//   subMeshes:    int32 count + SubMesh[48] each
//   blendShapes:  BlendShapeData (variable — see below)
//   indexBuffer:  byte[] (int32 len + bytes, align4)
//   skin:         BoneWeight4[] (int32 count × 32 bytes)
//   bindPoses:    Matrix4x4[] (int32 count × 64 bytes)
//   vertexCount:  uint32
//   channelCount: uint32
//   channels:     VertexAttributeDescriptor[] (4 bytes each)
//   streamCount:  uint32
//   streams:      StreamInfo[] (12 bytes each)
//   vertexData:   byte[] (int32 len + bytes)
// ══════════════════════════════════════════════════════════════
function extractMesh(u8, sourceName, LE) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        // name
        if (p + 4 > u8.length) return;
        const nLen = dv.getInt32(p, LE); p += 4;
        if (nLen < 0 || nLen > 4096 || p + nLen > u8.length) return;
        let name = new TextDecoder().decode(u8.slice(p, p+nLen)).replace(/\0/g,'').trim();
        p += nLen; p = a4(p);
        if (!name) name = `Mesh_${modelCount+1}`;

        const key = `${sourceName}||${name}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        p += 24; // AABB bounds (6 floats)

        // SubMeshes: firstByte(4)+indexCount(4)+topology(4)+baseVertex(4)+firstVertex(4)+vertexCount(4)+AABB(24) = 48
        if (p + 4 > u8.length) return;
        const smCount = dv.getInt32(p, LE); p += 4;
        if (smCount < 0 || smCount > 8192) return;
        const subMeshes = [];
        for (let i = 0; i < smCount; i++) {
            if (p + 48 > u8.length) return;
            const firstByte  = dv.getUint32(p,    LE);
            const indexCount = dv.getUint32(p+4,  LE);
            const topology   = dv.getInt32 (p+8,  LE);
            p += 48;
            subMeshes.push({ firstByte, indexCount, topology });
        }

        // BlendShapeData:
        //   shapes[]: firstVertex(4)+vertexCount(4)+hasNormals(1)+hasTangents(1), align4, name string
        if (p + 4 > u8.length) return;
        const bsCount = dv.getInt32(p, LE); p += 4;
        if (bsCount < 0 || bsCount > 8192) return;
        for (let i = 0; i < bsCount; i++) {
            if (p + 10 > u8.length) return;
            p += 8; // firstVertex + vertexCount
            p += 2; // hasNormals + hasTangents
            p = a4(p);
            if (p + 4 > u8.length) return;
            const snLen = dv.getInt32(p, LE); p += 4;
            if (snLen < 0 || snLen > 4096 || p + snLen > u8.length) return;
            p += snLen; p = a4(p);
        }
        //   channels[]: name string + hash(4) + frameIndex(4) + frameCount(4)
        if (p + 4 > u8.length) return;
        const bscCount = dv.getInt32(p, LE); p += 4;
        if (bscCount < 0 || bscCount > 8192) return;
        for (let i = 0; i < bscCount; i++) {
            if (p + 4 > u8.length) return;
            const cnLen = dv.getInt32(p, LE); p += 4;
            if (cnLen < 0 || cnLen > 4096 || p + cnLen > u8.length) return;
            p += cnLen; p = a4(p);
            p += 12; // hash(4)+frameIndex(4)+frameCount(4)
        }
        //   vertices[]: pos(12)+normal(12)+tangent(12)+index(4) = 40 bytes each
        if (p + 4 > u8.length) return;
        const bsfCount = dv.getInt32(p, LE); p += 4;
        if (bsfCount < 0 || bsfCount > 1_000_000) return;
        p += bsfCount * 40;

        // Index buffer
        if (p + 4 > u8.length) return;
        const ibLen = dv.getInt32(p, LE); p += 4;
        if (ibLen < 0 || ibLen > 100_000_000 || p + ibLen > u8.length) return;
        const indexBuf = u8.slice(p, p+ibLen);
        p += ibLen; p = a4(p);

        // Skin (BoneWeight4: 32 bytes each)
        if (p + 4 > u8.length) return;
        const skinCount = dv.getInt32(p, LE); p += 4;
        if (skinCount < 0 || skinCount > 2_000_000) return;
        p += skinCount * 32;

        // BindPoses (Matrix4x4: 64 bytes each)
        if (p + 4 > u8.length) return;
        const bpCount = dv.getInt32(p, LE); p += 4;
        if (bpCount < 0 || bpCount > 4096) return;
        p += bpCount * 64;

        // Vertex data
        if (p + 8 > u8.length) return;
        const vertexCount  = dv.getUint32(p, LE); p += 4;
        const channelCount = dv.getUint32(p, LE); p += 4;
        if (vertexCount === 0 || vertexCount > 5_000_000 || channelCount > 64) return;

        const channels = [];
        for (let i = 0; i < channelCount; i++) {
            if (p + 4 > u8.length) return;
            channels.push({ stream: u8[p++], offset: u8[p++], format: u8[p++], dimension: u8[p++] & 0xF });
        }

        // StreamInfo: offset(4)+stride(4)+dividerOp(1)+frequency(2)+pad(1) = 12 bytes
        if (p + 4 > u8.length) return;
        const streamCount = dv.getUint32(p, LE); p += 4;
        if (streamCount > 16) return;
        const streams = [];
        for (let i = 0; i < streamCount; i++) {
            if (p + 12 > u8.length) return;
            const sOff   = dv.getUint32(p, LE); p += 4;
            const stride = dv.getUint32(p, LE); p += 4;
            p += 4; // dividerOp(1)+frequency(2)+pad(1)
            streams.push({ offset: sOff, stride });
        }

        if (p + 4 > u8.length) return;
        const vbLen = dv.getInt32(p, LE); p += 4;
        if (vbLen < 0 || vbLen > 500_000_000 || p + vbLen > u8.length) return;
        const vBuf = u8.slice(p, p+vbLen);
        const vbDv = new DataView(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength);

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
                else if (ch.format === 3)  out.push((vbDv.getInt8(o) + 0.5) / 127.5);
                else if (ch.format === 4)  out.push(vbDv.getUint16(o, true) / 65535);
                else if (ch.format === 5)  out.push((vbDv.getInt16(o, true) + 0.5) / 32767.5);
                else if (ch.format === 6)  out.push(vbDv.getUint8(o));
                else if (ch.format === 7)  out.push(vbDv.getInt8(o));
                else if (ch.format === 8)  out.push(vbDv.getUint16(o, true));
                else if (ch.format === 9)  out.push(vbDv.getInt16(o, true));
                else if (ch.format === 10) out.push(vbDv.getUint32(o, true));
                else if (ch.format === 11) out.push(vbDv.getInt32(o, true));
                else                       out.push(vbDv.getFloat32(o, true));
            }
            return out;
        }

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
                    ? `vt ${uv[0].toFixed(6)} ${(1.0-uv[1]).toFixed(6)}`
                    : 'vt 0 0');
            }
        }

        const totalIdx = subMeshes.reduce((a,s) => a+s.indexCount, 0);
        const use32    = ibLen > 0 && totalIdx > 0 && (ibLen/totalIdx) > 2.5;
        const idxDv    = new DataView(indexBuf.buffer, indexBuf.byteOffset, indexBuf.byteLength);
        const getIdx   = use32 ? i => idxDv.getUint32(i*4, true) : i => idxDv.getUint16(i*2, true);
        const idxMax   = use32 ? Math.floor(ibLen/4) : Math.floor(ibLen/2);

        for (const sm of subMeshes) {
            if (sm.topology !== 0) continue;
            const iStart = Math.floor(sm.firstByte / (use32 ? 4 : 2));
            for (let i = 0; i+2 < sm.indexCount; i += 3) {
                if (iStart+i+2 >= idxMax) break;
                const a = getIdx(iStart+i)+1, b = getIdx(iStart+i+1)+1, c = getIdx(iStart+i+2)+1;
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
        postMessage({ type: 'MODEL_FOUND', data: { name, sourceName, vertexCount, faceCount, objText: lines.join('\n') } });
    } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// TEXTURE EXTRACTOR
// Unity Texture2D binary layout (little-endian object data):
//   name:               string (int32 len + bytes, align4)
//   forcedFallback:     int32
//   width:              int32
//   height:             int32
//   completeImageSize:  int32
//   mipsStripped:       int32  (Unity 2020.1+ / Unity 6)
//   textureFormat:      int32
//   mipCount:           int32
//   isReadable:         int32
//   ignoreMipmapLimit:  int32  (Unity 2022+)
//   streamingMipmaps:   int32
//   streamingPriority:  int32
//   imageCount:         int32
//   texDimension:       int32
//   filterMode+aniso+mipBias+wrapU+wrapV+wrapW: 6 × int32 = 24 bytes
//   lightmapFormat:     int32
//   colorSpace:         int32
//   platformBlob:       byte[] (int32 len + bytes, align4)
//   imageDataSize:      int32
//   imageData:          bytes  (0 = streaming via .resource file)
// ══════════════════════════════════════════════════════════════
const TEX_FORMAT_NAMES = {
    1:'Alpha8',2:'ARGB4444',3:'RGB24',4:'RGBA32',5:'ARGB32',7:'RGB565',
    9:'R16',10:'DXT1',12:'DXT5',13:'RGBA4444',14:'BGRA32',
    15:'RHalf',16:'RGHalf',17:'RGBAHalf',18:'RFloat',19:'RGFloat',20:'RGBAFloat',
    29:'DXT1Crunched',30:'DXT5Crunched',
    34:'PVRTC_RGB2',35:'PVRTC_RGBA2',36:'PVRTC_RGB4',37:'PVRTC_RGBA4',
    38:'ETC_RGB4',45:'EAC_R',46:'EAC_R_SIGNED',47:'EAC_RG',48:'EAC_RG_SIGNED',
    49:'ETC2_RGB',50:'ETC2_RGBA1',51:'ETC2_RGBA8',
    52:'ASTC_4x4',53:'ASTC_5x5',54:'ASTC_6x6',55:'ASTC_8x8',56:'ASTC_10x10',57:'ASTC_12x12',
    62:'ASTC_HDR_4x4',63:'ASTC_HDR_5x5',64:'ASTC_HDR_6x6',65:'ASTC_HDR_8x8',
    66:'ASTC_HDR_10x10',67:'ASTC_HDR_12x12',
    68:'ASTC_RGBA_4x4',69:'ASTC_RGBA_5x5',70:'ASTC_RGBA_6x6',71:'ASTC_RGBA_8x8',72:'ASTC_RGBA_12x12'
};

function extractTexture(u8, sourceName, LE) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        if (p + 4 > u8.length) return;
        const nLen = dv.getInt32(p, LE); p += 4;
        if (nLen < 0 || nLen > 4096 || p + nLen > u8.length) return;
        const name = new TextDecoder().decode(u8.slice(p, p+nLen)).replace(/\0/g,'').trim() || `Tex_${texCount+1}`;
        p += nLen; p = a4(p);

        const texKey = `${sourceName}||tex||${name}`;
        if (seenKeys.has(texKey)) return;
        seenKeys.add(texKey);

        if (p + 4 > u8.length) return;
        p += 4; // forcedFallbackFormat

        if (p + 12 > u8.length) return;
        const width  = dv.getInt32(p, LE); p += 4;
        const height = dv.getInt32(p, LE); p += 4;
        /* completeImageSize */ p += 4;

        if (width <= 0 || width > 16384 || height <= 0 || height > 16384) return;

        if (p + 4 > u8.length) return;
        p += 4; // mipsStripped (Unity 2020.1+)

        if (p + 4 > u8.length) return;
        const texFormat = dv.getInt32(p, LE); p += 4;
        const fmtName   = TEX_FORMAT_NAMES[texFormat] || `Fmt${texFormat}`;

        // mipCount(4)+isReadable(4)+ignoreMipmapLimit(4)+streamingMipmaps(4)+streamingPriority(4)
        // +imageCount(4)+texDimension(4) = 7 × 4 = 28 bytes
        if (p + 28 > u8.length) return;
        p += 28;

        // TextureSettings: filterMode+aniso+mipBias+wrapU+wrapV+wrapW = 24 bytes
        if (p + 24 > u8.length) return;
        p += 24;

        // lightmapFormat + colorSpace = 8 bytes
        if (p + 8 > u8.length) return;
        p += 8;

        // platformBlob
        if (p + 4 > u8.length) return;
        const blobLen = dv.getInt32(p, LE); p += 4;
        if (blobLen < 0 || blobLen > 1_000_000 || p + blobLen > u8.length) return;
        p += blobLen; p = a4(p);

        // imageDataSize
        if (p + 4 > u8.length) return;
        const imgDataSize = dv.getInt32(p, LE); p += 4;

        if (imgDataSize === 0) {
            // Streaming texture — data in paired .resource file
            texCount++; assetCount++;
            log(`TEX (streaming): ${name} ${width}×${height} ${fmtName}`, 'system');
            postMessage({ type: 'TEXTURE_FOUND', data: { name, sourceName, width, height, format: fmtName, formatId: texFormat, rawBytes: null, streaming: true } });
            return;
        }

        if (imgDataSize < 0 || imgDataSize > 100_000_000 || p + imgDataSize > u8.length) return;
        const imgData = u8.slice(p, p+imgDataSize);

        texCount++; assetCount++;
        log(`TEX: ${name} — ${width}×${height} ${fmtName} (${imgDataSize}B)`, 'success');

        const previewRGBA = tryDecodePixels(imgData, width, height, texFormat);

        postMessage({ type: 'TEXTURE_FOUND', data: {
            name, sourceName, width, height,
            format: fmtName, formatId: texFormat,
            rawBytes: imgData,
            previewRGBA,   // Uint8ClampedArray w×h×4 RGBA, Y-flipped, or null for compressed
            streaming: false,
        }});
    } catch(e) {}
}

// Decode uncompressed pixel formats to top-down RGBA (flips Unity's bottom-up storage)
function tryDecodePixels(imgData, w, h, fmt) {
    try {
        const n    = w * h;
        const rgba = new Uint8ClampedArray(n * 4);
        if (fmt === 4) {
            rgba.set(imgData.slice(0, n*4));
        } else if (fmt === 3) {
            for (let i = 0; i < n; i++) { rgba[i*4]=imgData[i*3]; rgba[i*4+1]=imgData[i*3+1]; rgba[i*4+2]=imgData[i*3+2]; rgba[i*4+3]=255; }
        } else if (fmt === 5) {
            for (let i = 0; i < n; i++) { rgba[i*4]=imgData[i*4+1]; rgba[i*4+1]=imgData[i*4+2]; rgba[i*4+2]=imgData[i*4+3]; rgba[i*4+3]=imgData[i*4]; }
        } else if (fmt === 14) {
            for (let i = 0; i < n; i++) { rgba[i*4]=imgData[i*4+2]; rgba[i*4+1]=imgData[i*4+1]; rgba[i*4+2]=imgData[i*4]; rgba[i*4+3]=imgData[i*4+3]; }
        } else if (fmt === 7) {
            for (let i = 0; i < n; i++) { const px=imgData[i*2]|(imgData[i*2+1]<<8); rgba[i*4]=((px>>11)&31)*255/31; rgba[i*4+1]=((px>>5)&63)*255/63; rgba[i*4+2]=(px&31)*255/31; rgba[i*4+3]=255; }
        } else if (fmt === 13) {
            for (let i = 0; i < n; i++) { const px=imgData[i*2]|(imgData[i*2+1]<<8); rgba[i*4]=((px>>12)&0xF)*17; rgba[i*4+1]=((px>>8)&0xF)*17; rgba[i*4+2]=((px>>4)&0xF)*17; rgba[i*4+3]=(px&0xF)*17; }
        } else if (fmt === 2) {
            for (let i = 0; i < n; i++) { const px=imgData[i*2]|(imgData[i*2+1]<<8); rgba[i*4]=((px>>8)&0xF)*17; rgba[i*4+1]=((px>>4)&0xF)*17; rgba[i*4+2]=(px&0xF)*17; rgba[i*4+3]=((px>>12)&0xF)*17; }
        } else if (fmt === 1) {
            for (let i = 0; i < n; i++) { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=255; rgba[i*4+3]=imgData[i]; }
        } else {
            return null; // compressed (ASTC/ETC2/DXT) — UI handles raw bytes
        }
        // Flip Y: Unity stores bottom-up
        const out = new Uint8ClampedArray(n*4), row = w*4;
        for (let r = 0; r < h; r++) { const s=(h-1-r)*row; out.set(rgba.slice(s,s+row),r*row); }
        return out;
    } catch(e) { return null; }
}

// ── Vertex format helpers ──────────────────────────────────────
function fmtBpe(f) {
    return f===0?4:f===1?2:f===2?1:f===3?1:f===4?2:f===5?2:f===6?1:f===7?1:f===8?2:f===9?2:f===10?4:f===11?4:4;
}

function f16(h) {
    const s=(h&0x8000)?-1:1, e=(h>>10)&0x1F, m=h&0x3FF;
    if(e===0)  return s*5.96046e-8*m;
    if(e===31) return m?NaN:s*Infinity;
    return s*Math.pow(2,e-15)*(1+m/1024);
}

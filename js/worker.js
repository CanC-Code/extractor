// js/worker.js — Unity APK extraction worker
// Uses the Wasm C++ engine (build/parser.js) for UnityFS parsing + LZ4.
// Falls back to pure-JS if Wasm isn't ready.

// ── State ─────────────────────────────────────────────────────
let wasmModule  = null;
let wasmReady   = false;
let modelCount  = 0;
let assetCount  = 0;
const seenKeys  = new Set();

// ── Logging helpers ────────────────────────────────────────────
function log(msg, logType = 'info') { postMessage({ type: 'LOG', data: msg, logType }); }
function progress(p)               { postMessage({ type: 'PROGRESS', data: p }); }

self.onerror = (message) => { log(`Worker error: ${message}`, 'error'); return true; };

// ── Load Wasm engine ───────────────────────────────────────────
self.Module = {
    locateFile(path) {
        if (path.endsWith('.wasm')) return '../build/' + path;
        return '../build/' + path;
    },
    onRuntimeInitialized() {
        wasmModule = self.Module;
        wasmReady  = true;
        log('Wasm engine ready.', 'success');
    },
    print:    (msg) => log(`[C++] ${msg}`, 'system'),
    printErr: (msg) => log(`[C++ ERR] ${msg}`, 'error'),
};

// Callback the C++ engine calls per extracted node
self.onFileExtracted = function(nodeName, bufferPtr, size, isSerializedContainer) {
    if (!wasmModule || size <= 0) return;

    // Copy out of Wasm heap BEFORE any further Wasm calls
    const heapSlice = new Uint8Array(wasmModule.HEAPU8.buffer, bufferPtr, size);
    const nodeBuf   = new Uint8Array(size);
    nodeBuf.set(heapSlice);

    const shortName = nodeName.split('/').pop() || nodeName;
    log(`Node: ${shortName} (${size} bytes)`, 'system');
    assetCount++;
    postMessage({ type: 'ASSET_FOUND_META', data: { name: nodeName, offset: 0, assetType: 'bundle' } });

    if (isSerializedContainer) {
        // Parse the serialized file for Mesh objects
        try { parseSerializedFile(nodeBuf, nodeName); }
        catch(e) { /* non-mesh nodes silent */ }
    }
};

try {
    importScripts('../build/parser.js');
} catch(e) {
    log('Wasm engine not found at ../build/parser.js — using pure-JS fallback.', 'error');
}

// ── ZIP constants ──────────────────────────────────────────────
const ZIP_LOCAL_SIG   = 0x04034B50;
const ZIP_CENTRAL_SIG = 0x02014B50;
const ZIP_EOCD_SIG    = 0x06054B50;

// ── Main message handler ───────────────────────────────────────
self.onmessage = async function(e) {
    if (e.data.type !== 'PROCESS_FILE') return;
    const file = e.data.file;

    modelCount = 0; assetCount = 0; seenKeys.clear();
    log(`Mounting: ${file.name}`, 'success');
    log(`Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    progress(3);

    try {
        const buf = await file.arrayBuffer();
        const u8  = new Uint8Array(buf);
        progress(15);

        // Parse ZIP central directory
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
        postMessage({ type: 'SCAN_COMPLETE', data: { modelCount, assetCount } });
        log(`Complete: ${modelCount} mesh(es), ${assetCount} assets.`, 'success');

    } catch(err) {
        log(`Fatal: ${err.message}`, 'error');
        console.error(err);
    }
};

// ── ZIP Central Directory parser ───────────────────────────────
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
        if (!name.endsWith('/')) {
            entries.push({ name, method, cSize, uSize, localOff });
        }
        p += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
}

function extractEntry(u8, entry) {
    const dv     = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p      = entry.localOff;
    if (dv.getUint32(p, true) !== ZIP_LOCAL_SIG) return null;
    const fnLen    = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start    = p + 30 + fnLen + extraLen;
    if (entry.method === 0) return u8.slice(start, start + entry.cSize); // stored
    return null; // deflate handled async
}

async function extractEntryAsync(u8, entry) {
    const sync = extractEntry(u8, entry);
    if (sync) return sync;
    // Deflate via DecompressionStream
    const dv     = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const p      = entry.localOff;
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

function isBundleCandidate(name) {
    // Unity AssetAssistant hash paths (no extension, hex filename)
    if (/assets\/[Aa]sset[Aa]ssistant\/syn\/[0-9a-fA-F]{2}\/[0-9a-fA-F]{20,}$/.test(name)) return true;
    if (/CAB-[0-9a-f]{10,}$/.test(name)) return true;
    if (/\.(bundle|assets|resource|unity3d)$/i.test(name)) return true;
    return false;
}

function isUnityFS(u8) {
    return u8.length >= 7
        && u8[0] === 0x55 && u8[1] === 0x6E && u8[2] === 0x69
        && u8[3] === 0x74 && u8[4] === 0x79 && u8[5] === 0x46 && u8[6] === 0x53;
}

// ── Bundle processor ───────────────────────────────────────────
async function processBundles(u8, rawBuf, entries) {
    // Report all files as assets
    for (const e of entries) {
        postMessage({ type: 'ASSET_FOUND_META', data: { name: e.name, offset: e.localOff, assetType: 'file' } });
        assetCount++;
    }

    const bundles = entries.filter(e => isBundleCandidate(e.name));
    log(`${bundles.length} UnityFS bundle candidate(s).`, 'system');

    for (let i = 0; i < bundles.length; i++) {
        progress(15 + Math.floor((i / bundles.length) * 82));
        const entry = bundles[i];
        const short = lastName(entry.name);
        try {
            const data = await extractEntryAsync(u8, entry);
            if (!data || data.length < 32) continue;
            if (!isUnityFS(data)) continue;

            log(`Parsing bundle: ${short}`, 'system');

            if (wasmReady && wasmModule) {
                // Route through the Wasm C++ engine
                const ptr = wasmModule._malloc(data.length);
                if (!ptr) { log(`Malloc failed for ${short}`, 'error'); continue; }
                wasmModule.HEAPU8.set(data, ptr);
                wasmModule.ccall('process_unity_archive', null, ['number', 'number'], [ptr, data.length]);
                wasmModule._free(ptr);
            } else {
                // Pure-JS fallback
                parseUnityFSBundle(data, entry.name);
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
        try {
            if (wasmReady && wasmModule) {
                const slice = u8.slice(offsets[i]);
                const ptr   = wasmModule._malloc(slice.length);
                if (!ptr) continue;
                wasmModule.HEAPU8.set(slice, ptr);
                wasmModule.ccall('process_unity_archive', null, ['number', 'number'], [ptr, slice.length]);
                wasmModule._free(ptr);
            } else {
                parseUnityFSBundle(u8.slice(offsets[i]), `raw_${i}`);
            }
        } catch(ex) {}
    }
}

function lastName(path) {
    const p = path.split('/'); const s = p[p.length - 1];
    return s.length > 22 ? s.slice(0, 10) + '…' + s.slice(-8) : s;
}

// ══════════════════════════════════════════════════════════════
// PURE-JS FALLBACK PIPELINE
// Used when Wasm isn't loaded. Mirrors the C++ logic.
// ══════════════════════════════════════════════════════════════

const COMP_NONE  = 0, COMP_LZ4 = 2, COMP_LZ4HC = 3;
const CLASS_MESH = 43;

function a4(n) { return (n + 3) & ~3; }

function lz4Decomp(src, maxOut) {
    const dst = new Uint8Array(maxOut);
    let sPos = 0, dPos = 0;
    while (sPos < src.length && dPos < dst.length) {
        const tok = src[sPos++];
        let litLen = tok >> 4, matchLen = tok & 0xF;
        if (litLen === 15)   { let x; do { x = src[sPos++]; litLen   += x; } while (x === 255 && sPos < src.length); }
        const litCopy = Math.min(litLen, dst.length - dPos, src.length - sPos);
        for (let i = 0; i < litCopy; i++) dst[dPos++] = src[sPos++];
        if (sPos >= src.length) break;
        const mOff = src[sPos] | (src[sPos + 1] << 8); sPos += 2;
        if (mOff === 0) break;
        if (matchLen === 15) { let x; do { x = src[sPos++]; matchLen += x; } while (x === 255 && sPos < src.length); }
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

function parseUnityFSBundle(u8, sourceName) {
    if (!u8 || u8.length < 48) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // Skip "UnityFS\0" (8 bytes)
    let p = 8;
    // format version uint32 BE
    p += 4;
    // Unity player version string (null-terminated)
    while (p < u8.length && u8[p] !== 0) p++; p++;
    // Unity engine version string (null-terminated)
    while (p < u8.length && u8[p] !== 0) p++; p++;
    // File size int64 BE — skip 8 bytes
    p += 8;

    if (p + 12 > u8.length) return;
    const ciSize = dv.getUint32(p, false); p += 4;
    const uiSize = dv.getUint32(p, false); p += 4;
    const flags  = dv.getUint32(p, false); p += 4;

    // p is now the first byte after the fixed header = where data begins
    const dataStart = p;
    const compression = flags & 0x3F;
    const blocksAtEnd = (flags & 0x80) !== 0;

    // Locate blocks-info bytes
    let biBytes;
    if (blocksAtEnd) {
        const biOff = u8.length - ciSize;
        if (biOff < dataStart || biOff + ciSize > u8.length) {
            log(`Blocks info OOB: ${lastName(sourceName)}`, 'error'); return;
        }
        biBytes = u8.slice(biOff, biOff + ciSize);
    } else {
        if (dataStart + ciSize > u8.length) {
            log(`Blocks info OOB: ${lastName(sourceName)}`, 'error'); return;
        }
        biBytes = u8.slice(dataStart, dataStart + ciSize);
    }

    const bi = decomp(biBytes, compression, uiSize);
    if (!bi) { log(`Blocks info decomp failed: ${lastName(sourceName)}`, 'error'); return; }

    const biDv = new DataView(bi.buffer, bi.byteOffset, bi.byteLength);
    let bp = 16; // skip hash

    if (bp + 4 > bi.length) return;
    const blockCount = biDv.getUint32(bp, false); bp += 4;
    if (blockCount > 100000) return;

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
    if (nodeCount > 100000) return;

    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        if (bp + 24 > bi.length) return;
        bp += 4; const offLo = biDv.getUint32(bp, false); bp += 4; // int64 offset, take lo
        bp += 4; const szLo  = biDv.getUint32(bp, false); bp += 4; // int64 size, take lo
        bp += 4; // flags
        const ns = bp; while (bp < bi.length && bi[bp] !== 0) bp++; const nodeName = new TextDecoder().decode(bi.slice(ns, bp)); bp++;
        nodes.push({ offset: offLo, size: szLo, name: nodeName });
    }

    // Decompress all data blocks
    let totalU = blocks.reduce((a, b) => a + b.uSz, 0);
    if (totalU === 0 || totalU > 512 * 1024 * 1024) return;

    const fullData = new Uint8Array(totalU);
    let wPos = 0;
    let rPos = blocksAtEnd ? dataStart : dataStart + ciSize;

    for (const block of blocks) {
        if (rPos + block.cSz > u8.length) break;
        const dec = decomp(u8.slice(rPos, rPos + block.cSz), block.comp, block.uSz);
        if (dec) fullData.set(dec.slice(0, Math.min(dec.length, block.uSz, fullData.length - wPos)), wPos);
        wPos += block.uSz;
        rPos += block.cSz;
    }

    // Parse each node
    for (const node of nodes) {
        if (node.size < 48 || node.offset + node.size > fullData.length) continue;
        try { parseSerializedFile(fullData.slice(node.offset, node.offset + node.size), node.name || sourceName); }
        catch(e) {}
    }
}

// ── Unity SerializedFile ───────────────────────────────────────
function parseSerializedFile(u8, sourceName) {
    if (u8.length < 32) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0;

    p += 4; // metaSize
    p += 4; // fileSize
    const version    = dv.getUint32(p, false); p += 4;
    const dataOffset = dv.getUint32(p, false); p += 4;

    if (version < 9 || version > 22) return;
    p += 4; // endian + 3 reserved

    while (p < u8.length && u8[p] !== 0) p++; p++; // unity version string

    if (version >= 13) {
        p += 4; // platform
        if (version >= 15) p += 1; // enableTypeTree
    }

    if (p + 4 > u8.length) return;
    const typeCount = dv.getInt32(p, false); p += 4;
    if (typeCount < 0 || typeCount > 65535) return;

    const classIds = [];
    for (let t = 0; t < typeCount; t++) {
        if (p + 4 > u8.length) return;
        const cid = dv.getInt32(p, false); p += 4;
        classIds.push(cid);
        if (version >= 16) p += 3; // isStripped + scriptTypeIndex
        if (version >= 13) {
            if ((version >= 16 && cid === 114) || (version < 16 && cid < 0)) p += 16; // scriptID
            p += 16; // oldTypeHash
        }
        if (version >= 15) {
            if (p + 8 > u8.length) return;
            const nc = dv.getInt32(p, false); p += 4;
            const sb = dv.getInt32(p, false); p += 4;
            if (nc < 0 || nc > 200000 || sb < 0 || sb > 5000000) return;
            p += nc * 24 + sb;
            if (version >= 21) { if (p + 4 > u8.length) return; const td = dv.getInt32(p, false); p += 4; p += td * 4; }
        }
    }

    if (p + 4 > u8.length) return;
    const objCount = dv.getInt32(p, false); p += 4;
    if (objCount < 0 || objCount > 200000) return;

    for (let i = 0; i < objCount; i++) {
        if (version >= 14) { p = a4(p); if (p + 8 > u8.length) return; p += 8; }
        else { if (p + 4 > u8.length) return; p += 4; }
        if (p + 12 > u8.length) return;
        const byteStart = dv.getUint32(p, false); p += 4;
        const byteSize  = dv.getUint32(p, false); p += 4;
        const typeIdx   = dv.getInt32(p, false);  p += 4;
        if (version < 16) { if (p + 2 > u8.length) return; p += 2; }

        if ((classIds[typeIdx] ?? -1) !== CLASS_MESH) continue;
        const abs = dataOffset + byteStart;
        if (abs + byteSize > u8.length) continue;
        extractMesh(u8.slice(abs, abs + byteSize), sourceName);
    }
}

// ── Mesh → OBJ ────────────────────────────────────────────────
function extractMesh(u8, sourceName) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        if (p + 4 > u8.length) return;
        const nLen = dv.getInt32(p, false); p += 4;
        if (nLen < 0 || nLen > 4096 || p + nLen > u8.length) return;
        let name = new TextDecoder().decode(u8.slice(p, p + nLen)).replace(/\0/g, '').trim();
        p += nLen; p = a4(p);
        if (!name) name = `Mesh_${modelCount + 1}`;

        const key = `${sourceName}||${name}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        p += 24; // Bounds AABB

        if (p + 4 > u8.length) return;
        const smCount = dv.getInt32(p, false); p += 4;
        if (smCount < 0 || smCount > 8192) return;
        const subMeshes = [];
        for (let i = 0; i < smCount; i++) {
            if (p + 28 > u8.length) return;
            const firstByte  = dv.getUint32(p, false); p += 4;
            const indexCount = dv.getUint32(p, false); p += 4;
            const topology   = dv.getInt32(p, false);  p += 4;
            p += 12; // baseVertex, firstVertex, vertexCount
            p += 24; // localAABB
            subMeshes.push({ firstByte, indexCount, topology });
        }

        // Skip blend shapes
        if (p + 4 > u8.length) return;
        const bsCount = dv.getInt32(p, false); p += 4;
        if (bsCount < 0 || bsCount > 8192) return;
        for (let i = 0; i < bsCount; i++) { p += 8; p = a4(p + 2); }
        if (p + 4 > u8.length) return;
        const bscCount = dv.getInt32(p, false); p += 4;
        if (bscCount < 0 || bscCount > 8192) return;
        for (let i = 0; i < bscCount; i++) {
            if (p + 4 > u8.length) return;
            const sl = dv.getInt32(p, false); p += 4;
            if (sl < 0 || sl > 4096 || p + sl > u8.length) return;
            p += sl; p = a4(p); p += 12;
        }
        if (p + 4 > u8.length) return;
        const bsfCount = dv.getInt32(p, false); p += 4;
        if (bsfCount < 0 || bsfCount > 1000000) return;
        p += bsfCount * 4;

        // Index buffer
        if (p + 4 > u8.length) return;
        const ibLen = dv.getInt32(p, false); p += 4;
        if (ibLen < 0 || ibLen > 100000000 || p + ibLen > u8.length) return;
        const indexBuf = u8.slice(p, p + ibLen);
        p += ibLen; p = a4(p);

        // Skin
        if (p + 4 > u8.length) return;
        const skinCount = dv.getInt32(p, false); p += 4;
        if (skinCount < 0 || skinCount > 2000000) return;
        p += skinCount * 32;

        // BindPoses
        if (p + 4 > u8.length) return;
        const bpCount = dv.getInt32(p, false); p += 4;
        if (bpCount < 0 || bpCount > 4096) return;
        p += bpCount * 64;

        // VertexData
        if (p + 8 > u8.length) return;
        const vertexCount  = dv.getUint32(p, false); p += 4;
        const channelCount = dv.getUint32(p, false); p += 4;
        if (vertexCount === 0 || vertexCount > 5000000 || channelCount > 64) return;

        const channels = [];
        for (let i = 0; i < channelCount; i++) {
            if (p + 4 > u8.length) return;
            channels.push({ stream: u8[p++], offset: u8[p++], format: u8[p++], dimension: u8[p++] & 0xF });
        }

        if (p + 4 > u8.length) return;
        const streamCount = dv.getUint32(p, false); p += 4;
        if (streamCount > 16) return;
        const streams = [];
        for (let i = 0; i < streamCount; i++) {
            if (p + 16 > u8.length) return;
            const sOff   = dv.getUint32(p, false); p += 4;
            const stride = dv.getUint32(p, false); p += 4;
            p += 8;
            streams.push({ offset: sOff, stride });
        }

        if (p + 4 > u8.length) return;
        const vbLen = dv.getInt32(p, false); p += 4;
        if (vbLen < 0 || vbLen > 500000000 || p + vbLen > u8.length) return;
        const vBuf  = u8.slice(p, p + vbLen);
        const vbDv  = new DataView(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength);

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
            if (sm.topology !== 0) continue;
            const iStart = Math.floor(sm.firstByte / (use32 ? 4 : 2));
            for (let i = 0; i < sm.indexCount - 2; i += 3) {
                if (iStart + i + 2 >= idxMax) break;
                const a = getIdx(iStart + i) + 1;
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

    } catch(e) { /* silent for non-mesh objects */ }
}

function fmtBpe(f) { return f===0?4: f===1?2: f===2?1: f===10?2: f===11?4: 4; }

function f16(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1F, m = h & 0x3FF;
    if (e === 0)  return s * 5.96e-8 * m;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

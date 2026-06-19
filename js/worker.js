// ============================================================
// WORKER.JS — Full Unity APK Mesh Extraction Pipeline
//
// Pipeline:
//   1. Parse APK as ZIP → find UnityFS bundle entries
//   2. For each bundle: parse UnityFS header
//   3. LZ4 decompress data blocks (pure JS, no Wasm needed)
//   4. Parse Unity SerializedFile object table
//   5. Find Mesh objects (classId 43)
//   6. De-interleave vertex/index buffers → OBJ text
//   7. Post MODEL_FOUND with embedded OBJ for immediate viewing + save
// ============================================================

const COMP_NONE  = 0;
const COMP_LZMA  = 1;
const COMP_LZ4   = 2;
const COMP_LZ4HC = 3;
const CLASS_MESH = 43;

const ZIP_LOCAL_SIG   = 0x04034B50;
const ZIP_CENTRAL_SIG = 0x02014B50;
const ZIP_EOCD_SIG    = 0x06054B50;

let modelCount = 0;
let assetCount = 0;
const seenMeshKeys = new Set();

// ============================================================
// ENTRY POINT
// ============================================================
self.onmessage = async function(e) {
    if (e.data.type !== 'PROCESS_FILE') return;

    const file = e.data.file;
    modelCount = 0;
    assetCount = 0;
    seenMeshKeys.clear();

    log(`MOUNTED: ${file.name}`, 'success');
    log(`SIZE: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    log('Reading full archive into memory…', 'system');
    progress(2);

    try {
        const arrayBuffer = await readAll(file);
        const u8 = new Uint8Array(arrayBuffer);
        progress(15);

        // Try ZIP first (APK is a ZIP)
        let zipEntries = null;
        try {
            zipEntries = parseZipCentralDirectory(u8);
            log(`ZIP index: ${zipEntries.length} entries.`, 'system');
        } catch(e2) {
            log(`ZIP parse failed: ${e2.message} — falling back to raw scan.`, 'error');
        }

        if (zipEntries && zipEntries.length > 0) {
            const bundles = zipEntries.filter(isBundleCandidate);
            log(`${bundles.length} UnityFS bundle candidate(s).`, 'system');
            if (bundles.length > 0) {
                await processBundles(u8, bundles);
            } else {
                await rawScan(u8);
            }
        } else {
            await rawScan(u8);
        }

        progress(100);
        self.postMessage({ type: 'SCAN_COMPLETE', data: { modelCount, assetCount } });
        log(`Done. ${modelCount} mesh(es) extracted.`, 'success');

    } catch(err) {
        log(`Fatal: ${err.message}`, 'error');
        console.error(err);
    }
};

function readAll(file) {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload  = () => res(fr.result);
        fr.onerror = () => rej(new Error('FileReader failed'));
        fr.readAsArrayBuffer(file);
    });
}

function log(msg, type = 'normal') {
    self.postMessage({ type: 'LOG', data: msg, logType: type });
}
function progress(pct) {
    self.postMessage({ type: 'PROGRESS', data: pct });
}

// ============================================================
// ZIP PARSER
// ============================================================
function parseZipCentralDirectory(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len  = u8.length;

    let eocdOffset = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
        if (view.getUint32(i, true) === ZIP_EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('No EOCD found');

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdSize   = view.getUint32(eocdOffset + 12, true);
    const entries  = [];
    let pos = cdOffset;

    while (pos < cdOffset + cdSize && pos + 46 <= len) {
        if (view.getUint32(pos, true) !== ZIP_CENTRAL_SIG) break;
        const compMethod  = view.getUint16(pos + 10, true);
        const compSize    = view.getUint32(pos + 20, true);
        const uncompSize  = view.getUint32(pos + 24, true);
        const fnLen       = view.getUint16(pos + 28, true);
        const extraLen    = view.getUint16(pos + 30, true);
        const commentLen  = view.getUint16(pos + 32, true);
        const localOffset = view.getUint32(pos + 42, true);
        const name        = new TextDecoder().decode(u8.slice(pos + 46, pos + 46 + fnLen));
        entries.push({ name, compMethod, compSize, uncompSize, localOffset });
        pos += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
}

function getLocalFileData(u8, entry) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const pos  = entry.localOffset;
    if (view.getUint32(pos, true) !== ZIP_LOCAL_SIG)
        throw new Error(`Bad local sig at 0x${pos.toString(16)}`);
    const fnLen    = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const start    = pos + 30 + fnLen + extraLen;
    // Method 0 = stored (Unity APKs almost always store bundle files uncompressed)
    if (entry.compMethod === 0) return u8.slice(start, start + entry.compSize);
    // Method 8 = deflate — use DecompressionStream async
    return null; // caller handles async inflate
}

async function getLocalFileDataAsync(u8, entry) {
    const data = getLocalFileData(u8, entry);
    if (data) return data;
    // Async deflate via DecompressionStream (Chrome 80+)
    const view  = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const pos   = entry.localOffset;
    const fnLen = view.getUint16(pos + 26, true);
    const extra = view.getUint16(pos + 28, true);
    const start = pos + 30 + fnLen + extra;
    const comp  = u8.slice(start, start + entry.compSize);
    if (typeof DecompressionStream === 'undefined') return null;
    try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(comp); writer.close();
        const chunks = []; let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); total += value.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    } catch(e) { return null; }
}

function isBundleCandidate(e) {
    const n = e.name;
    if (/assets\/[Aa]sset[Aa]ssistant\/syn\/[0-9a-fA-F]{2}\/[0-9a-fA-F]{28,}$/.test(n)) return true;
    if (/CAB-[0-9a-f]{16,}$/.test(n)) return true;
    if (/\.(bundle|assets|resource|unity3d|split\d*)$/i.test(n)) return true;
    return false;
}

// ============================================================
// BUNDLE PROCESSOR
// ============================================================
async function processBundles(apkU8, bundles) {
    const total = bundles.length;
    for (let i = 0; i < total; i++) {
        progress(15 + Math.floor((i / total) * 82));
        const entry = bundles[i];
        try {
            const data = await getLocalFileDataAsync(apkU8, entry);
            if (!data || data.length < 20) continue;
            const sig = readCStr(data, 0, 7);
            if (sig !== 'UnityFS') {
                assetCount++;
                self.postMessage({
                    type: 'ASSET_FOUND_META',
                    data: { name: entry.name, offset: entry.localOffset, assetType: 'other' }
                });
                continue;
            }
            log(`Parsing bundle: ${lastName(entry.name)}`, 'system');
            await parseUnityFSBundle(data, entry.name);
        } catch(err) {
            log(`Bundle [${lastName(entry.name)}]: ${err.message}`, 'error');
        }
    }
}

function lastName(path) {
    const p = path.split('/');
    const s = p[p.length - 1];
    return s.length > 20 ? s.slice(0, 10) + '…' + s.slice(-6) : s;
}

// ============================================================
// RAW SCAN FALLBACK
// ============================================================
async function rawScan(u8) {
    log('Raw binary scan for UnityFS blocks…', 'system');
    const offsets = [];
    for (let i = 0; i < u8.length - 7; i++) {
        if (u8[i]===0x55&&u8[i+1]===0x6E&&u8[i+2]===0x69&&
            u8[i+3]===0x74&&u8[i+4]===0x79&&u8[i+5]===0x46&&u8[i+6]===0x53) {
            offsets.push(i);
        }
    }
    log(`Found ${offsets.length} raw UnityFS block(s).`, 'system');
    for (let i = 0; i < offsets.length; i++) {
        progress(15 + Math.floor((i / offsets.length) * 82));
        try {
            await parseUnityFSBundle(u8.slice(offsets[i]), `raw_${i}`);
        } catch(e) {}
    }
}

// ============================================================
// UNITYFS BUNDLE PARSER
// ============================================================
async function parseUnityFSBundle(u8, sourceName) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // Skip signature "UnityFS\0" = 8 bytes
    let pos = 8;
    const formatVersion = dv.getUint32(pos, false); pos += 4;

    // Unity player version string (null-terminated)
    while (pos < u8.length && u8[pos] !== 0) pos++;
    pos++;
    // Unity engine version string (null-terminated)
    while (pos < u8.length && u8[pos] !== 0) pos++;
    pos++;

    // File size (int64 BE) — 8 bytes
    pos += 8;
    const ciBlocksInfoSize = dv.getUint32(pos, false); pos += 4;
    const uiBlocksInfoSize = dv.getUint32(pos, false); pos += 4;
    const archiveFlags     = dv.getUint32(pos, false); pos += 4;

    const compression  = archiveFlags & 0x3F;
    const blocksAtEnd  = (archiveFlags & 0x80) !== 0;

    // Read blocks info
    let biSrc;
    if (blocksAtEnd) {
        biSrc = u8.slice(u8.length - ciBlocksInfoSize);
    } else {
        biSrc = u8.slice(pos, pos + ciBlocksInfoSize);
        pos  += ciBlocksInfoSize;
    }

    const blocksInfo = decompress(biSrc, compression, uiBlocksInfoSize);
    if (!blocksInfo) { log(`Blocks info decompress failed: ${sourceName}`, 'error'); return; }

    const biDv = new DataView(blocksInfo.buffer, blocksInfo.byteOffset, blocksInfo.byteLength);
    let bp = 0;
    bp += 16; // uncompressed hash

    const blockCount = biDv.getUint32(bp, false); bp += 4;
    if (blockCount > 10000) return;
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
        const uSize  = biDv.getUint32(bp, false); bp += 4;
        const cSize  = biDv.getUint32(bp, false); bp += 4;
        const bFlags = biDv.getUint16(bp, false); bp += 2;
        blocks.push({ uSize, cSize, comp: bFlags & 0x3F });
    }

    const nodeCount = biDv.getUint32(bp, false); bp += 4;
    if (nodeCount > 10000) return;
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        // offset int64 BE
        bp += 4; const offLo = biDv.getUint32(bp, false); bp += 4;
        // size int64 BE
        bp += 4; const szLo  = biDv.getUint32(bp, false); bp += 4;
        const nodeFlags = biDv.getUint32(bp, false); bp += 4;
        const nStart = bp;
        while (bp < blocksInfo.length && blocksInfo[bp] !== 0) bp++;
        const nodeName = new TextDecoder().decode(blocksInfo.slice(nStart, bp));
        bp++;
        nodes.push({ offset: offLo, size: szLo, name: nodeName });
    }

    // Decompress all blocks into one flat buffer
    let totalUSize = 0;
    for (const b of blocks) totalUSize += b.uSize;
    const fullData = new Uint8Array(totalUSize);
    let wPos = 0;
    let rPos = blocksAtEnd ? pos : pos; // data starts at pos (already advanced past info)

    // If blocksAtEnd, we need to recalculate where data starts:
    // data is right after the header, before the blocks info at the end
    // pos was set to right after the header flags = correct data start
    if (blocksAtEnd) {
        // reset rPos to right after archiveFlags (4 bytes) which is where we stored pos
        // pos is already the correct data start position in both cases
    }

    for (const block of blocks) {
        if (rPos + block.cSize > u8.length) break;
        const cSlice = u8.slice(rPos, rPos + block.cSize);
        const dec    = decompress(cSlice, block.comp, block.uSize);
        if (dec) fullData.set(dec.slice(0, Math.min(dec.length, block.uSize)), wPos);
        wPos += block.uSize;
        rPos += block.cSize;
    }

    // Parse each serialized file node
    for (const node of nodes) {
        if (node.size < 48) continue;
        const slice = fullData.slice(node.offset, node.offset + node.size);
        try { parseSerializedFile(slice, node.name || sourceName); }
        catch(e) { /* skip non-mesh nodes silently */ }
    }
}

// ============================================================
// LZ4 BLOCK DECOMPRESSOR (pure JS)
// ============================================================
function lz4Decomp(src, maxOut) {
    const dst = new Uint8Array(maxOut);
    let sPos = 0, dPos = 0;
    while (sPos < src.length && dPos < maxOut) {
        const tok = src[sPos++];
        let litLen   = tok >> 4;
        let matchLen = tok & 0xF;
        if (litLen === 15) { let x; do { x = src[sPos++]; litLen += x; } while (x === 255); }
        const litEnd = Math.min(sPos + litLen, src.length);
        const cpyLen = Math.min(litLen, maxOut - dPos);
        dst.set(src.slice(sPos, sPos + cpyLen), dPos);
        sPos += litLen; dPos += cpyLen;
        if (sPos >= src.length) break;
        const mOff = src[sPos] | (src[sPos + 1] << 8); sPos += 2;
        if (mOff === 0) break;
        if (matchLen === 15) { let x; do { x = src[sPos++]; matchLen += x; } while (x === 255); }
        matchLen += 4;
        let mPos = dPos - mOff;
        const mEnd = Math.min(dPos + matchLen, maxOut);
        while (dPos < mEnd) dst[dPos++] = dst[mPos++];
    }
    return dst.slice(0, dPos);
}

function decompress(src, comp, uSize) {
    if (comp === COMP_NONE) return src;
    if (comp === COMP_LZ4 || comp === COMP_LZ4HC) {
        try { return lz4Decomp(src, uSize); }
        catch(e) { log(`LZ4 err: ${e.message}`, 'error'); return null; }
    }
    if (comp === COMP_LZMA) { log('LZMA unsupported — block skipped.', 'error'); return null; }
    return null;
}

// ============================================================
// UNITY SERIALIZED FILE — find Mesh objects
// ============================================================
function parseSerializedFile(u8, sourceName) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0;

    const metaSize   = dv.getUint32(p, false); p += 4;
    const fileSize   = dv.getUint32(p, false); p += 4;
    const version    = dv.getUint32(p, false); p += 4;
    const dataOffset = dv.getUint32(p, false); p += 4;

    if (version < 9 || version > 22) return;

    const endian = u8[p]; p += 4; // 1 byte endian + 3 reserved

    // unity version string (null-terminated)
    while (p < u8.length && u8[p] !== 0) p++; p++;

    if (version >= 13) {
        p += 4; // platform
        if (version >= 15) p += 1; // type tree enabled flag
    }

    // ── type tree (we parse to skip it + collect classIds) ──
    const typeCount = dv.getInt32(p, false); p += 4;
    if (typeCount < 0 || typeCount > 10000) return;
    const classIds = [];
    for (let t = 0; t < typeCount; t++) {
        const cid = dv.getInt32(p, false); p += 4;
        classIds.push(cid);
        if (version >= 16) p += 3; // isStripped + scriptTypeIndex
        if (version >= 13) {
            if ((version >= 16 && cid === 114) || (version < 16 && cid < 0)) p += 16; // scriptID
            p += 16; // oldTypeHash
        }
        if (version >= 15) {
            const nc = dv.getInt32(p, false); p += 4;
            const sb = dv.getInt32(p, false); p += 4;
            if (nc < 0 || nc > 100000) return;
            p += nc * 24 + sb;
            if (version >= 21) { const td = dv.getInt32(p, false); p += 4; p += td * 4; }
        }
    }

    // ── object table ────────────────────────────────────────
    const objCount = dv.getInt32(p, false); p += 4;
    if (objCount < 0 || objCount > 100000) return;

    for (let i = 0; i < objCount; i++) {
        if (version >= 14) { p = a4(p); p += 8; } // pathId int64
        else p += 4;
        const byteStart = dv.getUint32(p, false); p += 4;
        const byteSize  = dv.getUint32(p, false); p += 4;
        const typeIdx   = dv.getInt32(p, false);  p += 4;
        if (version < 16) p += 2; // classId in old versions

        const cid = classIds[typeIdx] ?? -1;
        if (cid === CLASS_MESH) {
            const abs = dataOffset + byteStart;
            if (abs + byteSize <= u8.length) {
                extractMesh(u8.slice(abs, abs + byteSize), sourceName);
            }
        }
    }
}

function a4(n) { return (n + 3) & ~3; }

// ============================================================
// MESH EXTRACTOR → OBJ
// ============================================================
function extractMesh(u8, sourceName) {
    try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 0;

        // name string
        const nLen = dv.getInt32(p, false); p += 4;
        if (nLen < 0 || nLen > 2048) return;
        let meshName = new TextDecoder().decode(u8.slice(p, p + nLen)).replace(/\0/g,'').trim();
        p += nLen; p = a4(p);
        if (!meshName) meshName = `Mesh_${modelCount + 1}`;

        const key = `${sourceName}||${meshName}`;
        if (seenMeshKeys.has(key)) return;
        seenMeshKeys.add(key);

        // Bounds AABB (6 floats = 24 bytes)
        p += 24;

        // SubMesh array
        const smCount = dv.getInt32(p, false); p += 4;
        if (smCount < 0 || smCount > 8192) return;
        const subMeshes = [];
        for (let i = 0; i < smCount; i++) {
            const firstByte  = dv.getUint32(p, false); p += 4;
            const indexCount = dv.getUint32(p, false); p += 4;
            const topology   = dv.getInt32(p, false);  p += 4;
            const baseVertex = dv.getUint32(p, false); p += 4;
            const firstVertex= dv.getUint32(p, false); p += 4;
            const vertexCount= dv.getUint32(p, false); p += 4;
            p += 24; // local AABB
            subMeshes.push({ firstByte, indexCount, topology, baseVertex, firstVertex, vertexCount });
        }

        // Blend shapes — skip
        const bsCount = dv.getInt32(p, false); p += 4;
        if (bsCount < 0 || bsCount > 8192) return;
        for (let i = 0; i < bsCount; i++) { p += 4; p += 4; p = a4(p + 2); }
        const bscCount = dv.getInt32(p, false); p += 4;
        if (bscCount < 0 || bscCount > 8192) return;
        for (let i = 0; i < bscCount; i++) {
            const sl = dv.getInt32(p, false); p += 4;
            if (sl < 0 || sl > 1024) return;
            p += sl; p = a4(p);
            p += 12;
        }
        const bsfCount = dv.getInt32(p, false); p += 4;
        if (bsfCount < 0 || bsfCount > 500000) return;
        p += bsfCount * 4;

        // Index buffer
        const ibLen = dv.getInt32(p, false); p += 4;
        if (ibLen < 0 || ibLen > 100000000) return;
        const indexBuf = u8.slice(p, p + ibLen);
        p += ibLen; p = a4(p);

        // Skin — skip
        const skinCount = dv.getInt32(p, false); p += 4;
        if (skinCount < 0 || skinCount > 2000000) return;
        p += skinCount * 32;

        // Bind poses — skip
        const bpCount = dv.getInt32(p, false); p += 4;
        if (bpCount < 0 || bpCount > 4096) return;
        p += bpCount * 64;

        // Vertex data
        const vertexCount  = dv.getUint32(p, false); p += 4;
        const channelCount = dv.getUint32(p, false); p += 4;
        if (vertexCount === 0 || vertexCount > 3000000) return;
        if (channelCount > 32) return;

        const channels = [];
        for (let i = 0; i < channelCount; i++) {
            const stream    = u8[p++];
            const offset    = u8[p++];
            const format    = u8[p++];
            const dimension = u8[p++] & 0xF;
            channels.push({ stream, offset, format, dimension });
        }

        const streamCount = dv.getUint32(p, false); p += 4;
        if (streamCount > 16) return;
        const streams = [];
        for (let i = 0; i < streamCount; i++) {
            const sOffset = dv.getUint32(p, false); p += 4;
            const stride  = dv.getUint32(p, false); p += 4;
            p += 8; // dividerOp + frequency
            streams.push({ offset: sOffset, stride });
        }

        const vbLen = dv.getInt32(p, false); p += 4;
        if (vbLen < 0 || vbLen > 200000000) return;
        const vBuf = u8.slice(p, p + vbLen);
        p += vbLen; p = a4(p);

        // ── Build OBJ ──────────────────────────────────────
        const readChan = (chanIdx, vtxIdx) => {
            if (chanIdx >= channels.length) return null;
            const ch = channels[chanIdx];
            if (ch.dimension === 0) return null;
            const st = streams[ch.stream];
            if (!st) return null;
            const bpe = fmtBytes(ch.format);
            const byteOff = st.offset + vtxIdx * st.stride + ch.offset;
            if (byteOff + ch.dimension * bpe > vBuf.length) return null;
            const vDv = new DataView(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength);
            const vals = [];
            for (let d = 0; d < ch.dimension; d++) {
                const o = byteOff + d * bpe;
                if (ch.format === 0)  vals.push(vDv.getFloat32(o, true));
                else if (ch.format === 1)  vals.push(f16f32(vDv.getUint16(o, true)));
                else if (ch.format === 2)  vals.push(vDv.getUint8(o) / 255.0);
                else if (ch.format === 10) vals.push(vDv.getUint16(o, true));
                else if (ch.format === 11) vals.push(vDv.getUint32(o, true));
                else vals.push(vDv.getFloat32(o, true));
            }
            return vals;
        };

        const lines = [`# APK Model Extractor`, `# ${meshName}`, `g ${meshName}`, ``];

        // vertices (channel 0)
        for (let v = 0; v < vertexCount; v++) {
            const p3 = readChan(0, v);
            if (p3 && p3.length >= 3) lines.push(`v ${p3[0].toFixed(6)} ${p3[1].toFixed(6)} ${p3[2].toFixed(6)}`);
            else lines.push('v 0 0 0');
        }

        // normals (channel 1)
        let hasNorm = channels.length > 1 && channels[1].dimension >= 3;
        if (hasNorm) {
            for (let v = 0; v < vertexCount; v++) {
                const n = readChan(1, v);
                if (n && n.length >= 3) lines.push(`vn ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
                else lines.push('vn 0 1 0');
            }
        }

        // UVs (channel 4 = UV0 in Unity 2018+; fallback to channel 2)
        const uvChan = (channels.length > 4 && channels[4].dimension >= 2) ? 4
                     : (channels.length > 2 && channels[2].dimension >= 2) ? 2 : -1;
        let hasUV = uvChan >= 0;
        if (hasUV) {
            for (let v = 0; v < vertexCount; v++) {
                const uv = readChan(uvChan, v);
                if (uv && uv.length >= 2) lines.push(`vt ${uv[0].toFixed(6)} ${uv[1].toFixed(6)}`);
                else lines.push('vt 0 0');
            }
        }

        // Determine index width (heuristic: >65535 unique indices means 32-bit)
        const totalIdxCount = subMeshes.reduce((a, s) => a + s.indexCount, 0);
        const use32 = ibLen > 0 && totalIdxCount > 0 && (ibLen / totalIdxCount) > 2.5;
        const idxDv = new DataView(indexBuf.buffer, indexBuf.byteOffset, indexBuf.byteLength);
        const getIdx = use32
            ? (i) => idxDv.getUint32(i * 4, true)
            : (i) => idxDv.getUint16(i * 2, true);

        for (const sm of subMeshes) {
            if (sm.topology !== 0) continue; // triangles only
            const start = sm.firstByte / (use32 ? 4 : 2);
            for (let i = 0; i < sm.indexCount; i += 3) {
                const a = getIdx(start + i) + 1;
                const b = getIdx(start + i + 1) + 1;
                const c = getIdx(start + i + 2) + 1;
                if (hasNorm && hasUV) lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
                else if (hasUV)      lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
                else if (hasNorm)    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
                else                 lines.push(`f ${a} ${b} ${c}`);
            }
        }

        const faceCount = lines.filter(l => l.startsWith('f ')).length;
        if (vertexCount < 3 || faceCount === 0) return;

        const objText = lines.join('\n');
        modelCount++;
        assetCount++;

        log(`MESH: ${meshName} — ${vertexCount}v, ${faceCount}f`, 'success');
        self.postMessage({
            type: 'MODEL_FOUND',
            data: {
                name: meshName,
                sourceName,
                vertexCount,
                faceCount,
                objText,   // full OBJ text for viewing AND saving
                viewable: true,
                ext: '.obj'
            }
        });

    } catch(e) {
        // silent — most failures are non-mesh serialized objects
    }
}

// ── Vertex format helpers ───────────────────────────────────
function fmtBytes(f) {
    if (f === 0)  return 4; // float32
    if (f === 1)  return 2; // float16
    if (f === 2)  return 1; // UNorm8
    if (f === 10) return 2; // UInt16
    if (f === 11) return 4; // UInt32
    return 4;
}

function f16f32(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1F;
    const m =  h & 0x3FF;
    if (e === 0)  return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

function readCStr(u8, off, max) {
    let s = '';
    for (let i = 0; i < max && off + i < u8.length; i++) {
        const c = u8[off + i];
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

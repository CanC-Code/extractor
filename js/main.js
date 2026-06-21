// js/main.js — Full UI + Three.js viewport + worker bridge

// ── Three.js setup ────────────────────────────────────────────
const canvas   = document.getElementById('renderCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d10);

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
camera.position.set(0, 5, 12);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(8, 16, 8);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x334466, 0x000000, 0.5));
scene.add(new THREE.GridHelper(40, 40, 0x1a1a1a, 0x111111));

// Simple orbit controls (built from scratch — no import needed)
let isDragging = false, lastX = 0, lastY = 0;
let orbitTheta = 0, orbitPhi = Math.PI / 4, orbitRadius = 12;
let orbitTarget = new THREE.Vector3(0, 1, 0);

function orbitUpdate() {
    const x = orbitTarget.x + orbitRadius * Math.sin(orbitPhi) * Math.sin(orbitTheta);
    const y = orbitTarget.y + orbitRadius * Math.cos(orbitPhi);
    const z = orbitTarget.z + orbitRadius * Math.sin(orbitPhi) * Math.cos(orbitTheta);
    camera.position.set(x, y, z);
    camera.lookAt(orbitTarget);
}
orbitUpdate();

canvas.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
canvas.addEventListener('touchstart', e => { isDragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }, { passive: true });
window.addEventListener('mouseup',   () => isDragging = false);
window.addEventListener('touchend',  () => isDragging = false);

function onMove(dx, dy) {
    if (!isDragging) return;
    orbitTheta -= dx * 0.008;
    orbitPhi    = Math.max(0.05, Math.min(Math.PI - 0.05, orbitPhi - dy * 0.008));
    orbitUpdate();
}
canvas.addEventListener('mousemove', e => onMove(e.clientX - lastX, e.clientY - lastY) || (lastX = e.clientX, lastY = e.clientY));
canvas.addEventListener('touchmove', e => {
    onMove(e.touches[0].clientX - lastX, e.touches[0].clientY - lastY);
    lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
}, { passive: true });
canvas.addEventListener('wheel', e => { orbitRadius = Math.max(0.5, Math.min(500, orbitRadius + e.deltaY * 0.05)); orbitUpdate(); }, { passive: true });

// Double-tap/click wireframe toggle
let lastTap = 0;
canvas.addEventListener('touchend', () => { const n = Date.now(); if (n - lastTap < 280) toggleWireframe(); lastTap = n; });
canvas.addEventListener('dblclick', toggleWireframe);

let wireframe = false;
function toggleWireframe() {
    wireframe = !wireframe;
    scene.traverse(c => { if (c.isMesh && c.userData.isModel) c.material.wireframe = wireframe; });
}

// Resize
function resizeRenderer() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
}

// Render loop
(function animate() {
    requestAnimationFrame(animate);
    resizeRenderer();
    renderer.render(scene, camera);
})();

// ── UI Elements ────────────────────────────────────────────────
const logsEl      = document.getElementById('logs');
const statusBadge = document.getElementById('statusBadge');
const statusText  = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const modelList   = document.getElementById('modelList');
const assetList   = document.getElementById('assetList');
const modelCount  = document.getElementById('modelCount');
const assetCount  = document.getElementById('assetCount');
const scanCount   = document.getElementById('scanCount');
const meshStats   = document.getElementById('meshStats');
const saveAllBtn  = document.getElementById('saveAllBtn');

let totalModels = 0, totalAssets = 0;
const seenAssets = new Set();
const modelStore = {}; // name → OBJ text

// ── Logging ────────────────────────────────────────────────────
function log(msg, type = 'info') {
    const d = document.createElement('div');
    d.className = type === 'error'   ? 'text-red-400'
                : type === 'success' ? 'text-emerald-400'
                : type === 'system'  ? 'text-blue-400'
                :                      'text-zinc-400';
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    d.textContent = `[${ts}] ${msg}`;
    logsEl.appendChild(d);
    while (logsEl.children.length > 600) logsEl.removeChild(logsEl.firstChild);
    logsEl.scrollTop = logsEl.scrollHeight;
}

function setStatus(msg, colour = 'text-zinc-400') {
    statusBadge.textContent = msg;
    statusBadge.className = `bg-zinc-900/80 backdrop-blur-sm px-3 py-1 rounded-full text-[10px]
                              border border-zinc-700 uppercase tracking-widest ${colour}`;
    statusText.textContent = msg;
}

// ── OBJ Loader (manual — no module import needed) ──────────────
function loadOBJ(objText, name) {
    // Remove old model
    const toRemove = [];
    scene.traverse(c => { if (c.userData.isModel) toRemove.push(c); });
    toRemove.forEach(c => {
        scene.remove(c);
        c.geometry?.dispose();
        if (c.material) { if (Array.isArray(c.material)) c.material.forEach(m => m.dispose()); else c.material.dispose(); }
    });
    wireframe = false;

    const vertices = [], normals = [], uvs = [], faces = [];
    for (const rawLine of objText.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('v '))  { const p = line.split(/\s+/); vertices.push(+p[1], +p[2], +p[3]); }
        if (line.startsWith('vn ')) { const p = line.split(/\s+/); normals.push(+p[1], +p[2], +p[3]); }
        if (line.startsWith('vt ')) { const p = line.split(/\s+/); uvs.push(+p[1], +p[2]); }
        if (line.startsWith('f '))  {
            const parts = line.split(/\s+/).slice(1);
            // Triangulate (fan)
            for (let i = 1; i < parts.length - 1; i++) {
                faces.push(parts[0], parts[i], parts[i + 1]);
            }
        }
    }

    const posArr = [], normArr = [], uvArr = [];
    for (const token of faces) {
        const [vi, ti, ni] = token.split('/').map(x => parseInt(x) - 1);
        posArr.push(vertices[vi*3], vertices[vi*3+1], vertices[vi*3+2]);
        if (!isNaN(ni) && ni >= 0) normArr.push(normals[ni*3], normals[ni*3+1], normals[ni*3+2]);
        if (!isNaN(ti) && ti >= 0) uvArr.push(uvs[ti*2], uvs[ti*2+1]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    if (normArr.length === posArr.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
    else geo.computeVertexNormals();
    if (uvArr.length > 0) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));

    const mat  = new THREE.MeshStandardMaterial({ color: 0x7ecfa0, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isModel = true;

    // Auto-centre + scale
    geo.computeBoundingBox();
    const box    = geo.boundingBox;
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    const size   = new THREE.Vector3();
    box.getSize(size);
    const maxD   = Math.max(size.x, size.y, size.z) || 1;
    const scale  = 8 / maxD;
    mesh.scale.setScalar(scale);
    mesh.position.copy(centre).negate().multiplyScalar(scale);

    scene.add(mesh);

    orbitTarget.set(0, (size.y * scale) * 0.3, 0);
    orbitRadius = size.z * scale * 2.5 || 12;
    orbitUpdate();

    const vCount = posArr.length / 3;
    const fCount = faces.length / 3;
    meshStats.textContent = `${name} — V: ${vCount.toLocaleString()} · F: ${fCount.toLocaleString()}`;
    meshStats.classList.remove('hidden');
    setStatus(`Viewing: ${name}`, 'text-emerald-400');
}

// ── Model card builder ─────────────────────────────────────────
function addModelCard(data) {
    if (seenAssets.has('MODEL::' + data.name)) return;
    seenAssets.add('MODEL::' + data.name);
    totalModels++;
    modelCount.textContent = totalModels;
    modelStore[data.name] = data.objText;
    saveAllBtn.classList.remove('hidden');

    const li = document.createElement('li');
    li.className = 'flex items-center justify-between gap-1 bg-zinc-800 rounded px-2 py-1';
    li.innerHTML = `
        <div class="flex-1 min-w-0">
            <div class="text-[10px] font-mono text-white truncate" title="${esc(data.name)}">${esc(data.name)}</div>
            <div class="text-[9px] text-zinc-500">${(data.vertexCount||0).toLocaleString()}v · ${(data.faceCount||0).toLocaleString()}f</div>
        </div>
        <div class="flex gap-1 flex-shrink-0">
            <button onclick="viewModel('${escA(data.name)}')"
                    class="text-[9px] bg-emerald-600 hover:bg-emerald-500 rounded px-1.5 py-0.5 font-bold text-white transition">
                VIEW
            </button>
            <button onclick="saveModel('${escA(data.name)}')"
                    class="text-[9px] border border-zinc-600 hover:bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-300 transition">
                OBJ
            </button>
        </div>
    `;
    modelList.appendChild(li);
}

// ── Asset list builder ─────────────────────────────────────────
function addAssetEntry(name, offset) {
    if (seenAssets.has(name)) return;
    seenAssets.add(name);
    totalAssets++;
    assetCount.textContent = totalAssets;
    scanCount.textContent  = `${totalAssets} found`;

    const li = document.createElement('li');
    li.className = 'text-[9px] font-mono text-zinc-500 truncate';
    li.title = name;
    li.textContent = name.split('/').pop() || name;
    assetList.appendChild(li);
}

// ── Global actions ─────────────────────────────────────────────
window.viewModel = function(name) {
    const obj = modelStore[name];
    if (!obj) { log(`No OBJ data for: ${name}`, 'error'); return; }
    try { loadOBJ(obj, name); } catch(e) { log(`Render error: ${e.message}`, 'error'); }
};

window.saveModel = function(name) {
    const obj = modelStore[name];
    if (!obj) return;
    const blob = new Blob([obj], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.obj';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    log(`Saved: ${a.download}`, 'success');
};

saveAllBtn.addEventListener('click', async () => {
    const entries = Object.entries(modelStore);
    if (!entries.length) return;
    setStatus('Packaging ZIP…', 'text-blue-400');
    // Load JSZip dynamically
    if (!window.JSZip) {
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
        });
    }
    const zip = new window.JSZip();
    for (const [name, text] of entries) {
        zip.file(name.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.obj', text);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'extracted_models.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    log(`Saved ZIP: ${entries.length} models`, 'success');
    setStatus(`Saved ${entries.length} models`, 'text-emerald-400');
});

// ── Worker ─────────────────────────────────────────────────────
const worker = new Worker('js/worker.js');

worker.onmessage = ({ data: msg }) => {
    const { type, data, logType } = msg;
    switch (type) {
        case 'LOG':
            log(data, logType || 'info');
            statusText.textContent = data.length < 90 ? data : data.slice(0, 87) + '…';
            break;
        case 'STATUS':
            setStatus(data.message,
                data.state === 'scanning' ? 'text-blue-400' :
                data.state === 'done'     ? 'text-emerald-400' : 'text-zinc-400');
            break;
        case 'PROGRESS':
            progressBar.value = data;
            break;
        case 'ASSET_FOUND_META':
            addAssetEntry(data.name, data.offset);
            break;
        case 'MODEL_FOUND':
            addModelCard(data);
            break;
        case 'SCAN_COMPLETE':
            progressBar.value = 100;
            setStatus(`Done — ${data.modelCount} model(s)`, 'text-emerald-400');
            log(`Scan complete. ${data.modelCount} mesh(es), ${data.assetCount} assets.`, 'success');
            break;
    }
};

worker.onerror = e => log(`Worker: ${e.message}`, 'error');

// ── File input ─────────────────────────────────────────────────
function startProcessing(file) {
    if (!file) return;

    // Reset
    logsEl.innerHTML = ''; modelList.innerHTML = ''; assetList.innerHTML = '';
    totalModels = 0; totalAssets = 0;
    seenAssets.clear();
    Object.keys(modelStore).forEach(k => delete modelStore[k]);
    modelCount.textContent = '0'; assetCount.textContent = '0'; scanCount.textContent = '0 found';
    progressBar.value = 0;
    meshStats.classList.add('hidden');
    saveAllBtn.classList.add('hidden');
    wireframe = false;

    log(`Loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'success');
    setStatus('Scanning…', 'text-blue-400');
    worker.postMessage({ type: 'PROCESS_FILE', file });
}

// The label correctly forwards clicks to the input — just listen to change
document.getElementById('fileInput').addEventListener('change', e => {
    startProcessing(e.target.files[0]);
    e.target.value = ''; // allow re-selecting same file
});

// Drag and drop on the whole page
document.addEventListener('dragover',  e => { e.preventDefault(); document.getElementById('dropZone').classList.add('dragover'); });
document.addEventListener('dragleave', e => { document.getElementById('dropZone').classList.remove('dragover'); });
document.addEventListener('drop', e => {
    e.preventDefault();
    document.getElementById('dropZone').classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) startProcessing(file);
});

// ── Helpers ────────────────────────────────────────────────────
function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escA(s) { return String(s).replace(/'/g,"\\'"); }

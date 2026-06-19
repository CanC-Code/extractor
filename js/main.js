// ============================================================
// MAIN.JS — Three.js Viewport + Worker Bridge + Save-to-Disk
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader }     from 'three/addons/loaders/OBJLoader.js';

// ============================================================
// VIEWPORT
// ============================================================
const container = document.getElementById('viewport-container');
const canvas    = document.getElementById('viewer-canvas');
const scene     = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.001, 10000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.08;
controls.screenSpacePanning = false;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(8, 16, 8);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x334455, 0x000000, 0.5));
scene.add(new THREE.GridHelper(40, 40, 0x1c1c1c, 0x141414));

let currentModel = null;
let wireframe = false;

(function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
})();

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// Double-tap canvas to toggle wireframe
let lastTap = 0;
canvas.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 280 && currentModel) toggleWireframe();
    lastTap = now;
}, { passive: true });
canvas.addEventListener('dblclick', () => { if (currentModel) toggleWireframe(); });

function toggleWireframe() {
    wireframe = !wireframe;
    currentModel.traverse(c => { if (c.isMesh) c.material.wireframe = wireframe; });
}

// ============================================================
// OBJ LOADER
// ============================================================
const objLoader = new OBJLoader();

function loadObjText(objText, name) {
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) { if (Array.isArray(c.material)) c.material.forEach(m=>m.dispose()); else c.material.dispose(); }
        });
        currentModel = null;
    }
    wireframe = false;

    const obj = objLoader.parse(objText);
    const mat = new THREE.MeshStandardMaterial({ color: 0x7ec8a0, roughness: 0.55, metalness: 0.05 });
    obj.traverse(c => { if (c.isMesh) { c.material = mat; c.castShadow = true; } });

    // Auto-center + scale
    const box    = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale  = maxDim > 0 ? 8 / maxDim : 1;
    obj.scale.setScalar(scale);
    obj.position.copy(center.multiplyScalar(-scale));
    obj.position.y -= box.min.y * scale;

    scene.add(obj);
    currentModel = obj;

    // Reset camera
    camera.position.set(0, size.y * scale * 0.8, size.z * scale * 2.5 || 10);
    controls.target.set(0, size.y * scale * 0.3, 0);
    controls.update();

    // Stats overlay
    let verts = 0, faces = 0;
    obj.traverse(c => {
        if (c.isMesh && c.geometry) {
            verts += c.geometry.attributes.position?.count || 0;
            faces += c.geometry.index
                ? c.geometry.index.count / 3
                : (c.geometry.attributes.position?.count || 0) / 3;
        }
    });
    document.getElementById('stat-verts').textContent = `V: ${verts.toLocaleString()}`;
    document.getElementById('stat-faces').textContent = `F: ${Math.floor(faces).toLocaleString()}`;
    document.getElementById('model-stats').classList.remove('hidden');
    document.getElementById('stat-name').textContent  = name;
}

// ============================================================
// UI STATE
// ============================================================
const terminal     = document.getElementById('terminal-log');
const logContainer = document.getElementById('tab-logs');
const statusText   = document.getElementById('status-text');
const progressBar  = document.getElementById('progress-bar');
const modelList    = document.getElementById('model-list');
const assetList    = document.getElementById('asset-list');
const modelCountEl = document.getElementById('model-count');
const assetCountEl = document.getElementById('asset-count');
const noModelsMsg  = document.getElementById('no-models-msg');

let totalModels = 0;
let totalAssets = 0;
const seenModels = new Set();
const seenAssets = new Set();

// In-memory store of all OBJ texts for saving
const modelStore = {}; // name → objText

// ============================================================
// LOGGING
// ============================================================
function addLog(msg, type = 'normal') {
    const div  = document.createElement('div');
    div.className = `log-entry ${type}`;
    const now = new Date();
    const ts  = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.${p3(now.getMilliseconds())}`;
    div.textContent = `[${ts}] ${msg}`;
    terminal.appendChild(div);
    while (terminal.children.length > 800) terminal.removeChild(terminal.firstChild);
    logContainer.scrollTop = logContainer.scrollHeight;
}
const p2 = n => String(n).padStart(2,'0');
const p3 = n => String(n).padStart(3,'0');

// ============================================================
// TAB SWITCHING
// ============================================================
window.switchTab = function(name) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + name).classList.remove('hidden');
    document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
};

// ============================================================
// MODEL VIEWER — invoked from model card buttons
// ============================================================
window.viewModel = function(key) {
    const obj = modelStore[key];
    if (!obj) { addLog(`OBJ data not found for: ${key}`, 'error'); return; }
    addLog(`Loading: ${key}`, 'system');
    statusText.textContent = `Viewing: ${key}`;
    try {
        loadObjText(obj, key);
        // Switch to viewport (scroll up on mobile)
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch(e) {
        addLog(`Render error: ${e.message}`, 'error');
    }
};

// ============================================================
// SAVE OBJ — trigger browser download
// ============================================================
window.saveModel = function(key) {
    const objText = modelStore[key];
    if (!objText) { addLog(`No data to save for: ${key}`, 'error'); return; }
    const safeFileName = key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.obj';
    const blob = new Blob([objText], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = safeFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    addLog(`Saved: ${safeFileName}`, 'success');
};

// ============================================================
// SAVE ALL — zip all OBJs using JSZip (loaded dynamically)
// ============================================================
window.saveAllModels = async function() {
    if (totalModels === 0) return;
    statusText.textContent = 'Packaging all models…';
    addLog(`Packaging ${totalModels} model(s) into ZIP…`, 'system');

    try {
        // Dynamically load JSZip from CDN
        if (typeof JSZip === 'undefined') {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        }
        const zip = new JSZip();
        for (const [key, text] of Object.entries(modelStore)) {
            const fname = key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.obj';
            zip.file(fname, text);
        }
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'extracted_models.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        addLog(`ZIP saved: ${totalModels} models (${(blob.size/1024).toFixed(0)} KB)`, 'success');
        statusText.textContent = `Saved ${totalModels} model(s).`;
    } catch(e) {
        addLog(`ZIP error: ${e.message}`, 'error');
    }
};

function loadScript(src) {
    return new Promise((res, rej) => {
        const s  = document.createElement('script');
        s.src    = src;
        s.onload = res;
        s.onerror= () => rej(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

// ============================================================
// BUILD MODEL CARD
// ============================================================
function addModelCard(data) {
    const key = data.name;
    if (seenModels.has(key)) return;
    seenModels.add(key);
    totalModels++;
    modelCountEl.textContent = totalModels;
    noModelsMsg.classList.add('hidden');

    // Store OBJ for view + save
    modelStore[key] = data.objText;

    const li = document.createElement('li');
    li.className = 'model-card';
    li.innerHTML = `
        <div class="mc-info">
            <span class="mc-badge">OBJ</span>
            <span class="mc-name">${esc(key)}</span>
            <span class="mc-meta">${data.vertexCount.toLocaleString()} verts · ${data.faceCount.toLocaleString()} faces</span>
            <span class="mc-src">${esc(shortSrc(data.sourceName))}</span>
        </div>
        <div class="mc-actions">
            <button class="btn-view"  onclick="viewModel('${escAttr(key)}')">VIEW</button>
            <button class="btn-save"  onclick="saveModel('${escAttr(key)}')">⬇ OBJ</button>
        </div>
    `;
    modelList.appendChild(li);
}

function addAssetEntry(data) {
    if (seenAssets.has(data.name)) return;
    seenAssets.add(data.name);
    totalAssets++;
    assetCountEl.textContent = totalAssets;
    const li = document.createElement('li');
    li.className = 'asset-entry';
    li.innerHTML = `
        <span class="asset-name">${esc(data.name)}</span>
        <span class="asset-meta">0x${(data.offset||0).toString(16).toUpperCase()}</span>
    `;
    assetList.appendChild(li);
}

function shortSrc(s) {
    if (!s) return '';
    const parts = s.split('/');
    return parts[parts.length - 1].slice(0, 28);
}
function esc(s)     { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/'/g,"\\'"); }

// ============================================================
// WORKER
// ============================================================
let worker;
try {
    worker = new Worker('js/worker.js');
    addLog('Parse worker spawned.', 'system');
} catch(e) {
    addLog(`Worker spawn failed: ${e.message}`, 'error');
}

worker.onmessage = function({ data: msg }) {
    const { type, data, logType } = msg;
    switch (type) {
        case 'LOG':
            addLog(data, logType || 'normal');
            if (data.length < 90) statusText.textContent = data;
            break;
        case 'PROGRESS':
            progressBar.value = data;
            break;
        case 'MODEL_FOUND':
            addModelCard(data);
            if (totalModels === 1) switchTab('models');
            break;
        case 'ASSET_FOUND_META':
            addAssetEntry(data);
            break;
        case 'SCAN_COMPLETE':
            progressBar.value = 100;
            statusText.textContent = `Complete. ${data.modelCount} model(s) found.`;
            addLog(`Scan complete — ${data.modelCount} mesh(es), ${data.assetCount} assets.`, 'success');
            document.getElementById('save-all-btn').style.display = data.modelCount > 0 ? 'inline-flex' : 'none';
            if (data.modelCount === 0) {
                noModelsMsg.classList.remove('hidden');
                noModelsMsg.textContent = 'No Mesh objects found. The APK may use Addressables with encrypted bundles, or a non-Unity engine.';
            }
            break;
    }
};

worker.onerror = function(err) {
    addLog(`Worker error: ${err.message}`, 'error');
};

// ============================================================
// FILE INPUT
// ============================================================
document.getElementById('apk-upload').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Reset
    terminal.innerHTML         = '';
    modelList.innerHTML        = '';
    assetList.innerHTML        = '';
    totalModels = 0; totalAssets = 0;
    seenModels.clear(); seenAssets.clear();
    Object.keys(modelStore).forEach(k => delete modelStore[k]);
    modelCountEl.textContent   = '0';
    assetCountEl.textContent   = '0';
    progressBar.value          = 0;
    document.getElementById('model-stats').classList.add('hidden');
    document.getElementById('save-all-btn').style.display = 'none';
    noModelsMsg.classList.remove('hidden');
    noModelsMsg.textContent = 'Scanning…';

    if (currentModel) { scene.remove(currentModel); currentModel = null; }

    switchTab('logs');
    worker.postMessage({ type: 'PROCESS_FILE', file });
    event.target.value = '';
});

window.onerror = function(msg, src, line) {
    addLog(`JS ERROR: ${msg} (line ${line})`, 'error');
};

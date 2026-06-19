// ============================================================
// MAIN.JS — Three.js Viewport + Worker Bridge
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// ============================================================
// VIEWPORT SETUP
// ============================================================
const container = document.getElementById('viewport-container');
const canvas    = document.getElementById('viewer-canvas');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 5000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Lighting rig
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0x223344, 0x000000, 0.5));
scene.add(new THREE.GridHelper(30, 30, 0x222222, 0x181818));

let currentModel = null;

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// ============================================================
// UI STATE
// ============================================================
const terminal      = document.getElementById('terminal-log');
const logContainer  = document.getElementById('tab-logs');
const statusText    = document.getElementById('status-text');
const progressBar   = document.getElementById('progress-bar');
const assetList     = document.getElementById('asset-list');
const modelList     = document.getElementById('model-list');
const assetCount    = document.getElementById('asset-count');
const modelCount    = document.getElementById('model-count');
const modelStats    = document.getElementById('model-stats');
const statVerts     = document.getElementById('stat-verts');
const statFaces     = document.getElementById('stat-faces');
const noModelsMsg   = document.getElementById('no-models-msg');

let totalAssets = 0;
let totalModels = 0;
const seenAssets = new Set();
const seenModels = new Set();

// ============================================================
// LOGGING
// ============================================================
function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const now = new Date();
    const ts  = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad3(now.getMilliseconds())}`;
    div.innerText = `[${ts}] ${msg}`;
    terminal.appendChild(div);
    // Keep log trimmed to last 500 entries to avoid DOM bloat on large APKs
    while (terminal.children.length > 500) terminal.removeChild(terminal.firstChild);
    logContainer.scrollTop = logContainer.scrollHeight;
}

const pad  = n => String(n).padStart(2, '0');
const pad3 = n => String(n).padStart(3, '0');

// ============================================================
// TAB SWITCHING
// ============================================================
window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.remove('hidden');
    // Find the button that matches by data-tab attribute
    document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');
};

// ============================================================
// MODEL VIEWER
// ============================================================
function loadObjText(objText, name) {
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        });
        currentModel = null;
    }

    const loader = new OBJLoader();
    const obj = loader.parse(objText);

    // Apply a clean material
    const mat = new THREE.MeshStandardMaterial({
        color: 0x88ccaa,
        roughness: 0.6,
        metalness: 0.1,
        wireframe: false
    });
    obj.traverse(c => { if (c.isMesh) c.material = mat; });

    // Auto-center and scale
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale  = maxDim > 0 ? 6 / maxDim : 1;
    obj.scale.setScalar(scale);
    obj.position.sub(center.multiplyScalar(scale));

    scene.add(obj);
    currentModel = obj;

    // Stats
    let verts = 0, faces = 0;
    obj.traverse(c => {
        if (c.isMesh && c.geometry) {
            verts += c.geometry.attributes.position?.count || 0;
            faces += (c.geometry.index ? c.geometry.index.count / 3 : (c.geometry.attributes.position?.count || 0) / 3);
        }
    });
    statVerts.textContent = `V: ${verts.toLocaleString()}`;
    statFaces.textContent = `F: ${Math.floor(faces).toLocaleString()}`;
    modelStats.classList.remove('hidden');

    addLog(`Loaded model: ${name} | ${verts.toLocaleString()} verts, ${Math.floor(faces).toLocaleString()} faces`, 'success');
    statusText.innerText = `Viewing: ${name}`;
}

// Toggle wireframe with double-tap on canvas
let lastTap = 0;
canvas.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 300 && currentModel) {
        currentModel.traverse(c => {
            if (c.isMesh) c.material.wireframe = !c.material.wireframe;
        });
    }
    lastTap = now;
});

// ============================================================
// ASSET LIST BUILDERS
// ============================================================

// Type → badge color map
const TYPE_COLORS = {
    model:    '#00e676',
    texture:  '#29b6f6',
    audio:    '#ab47bc',
    material: '#ffca28',
    scene:    '#ff7043',
    other:    '#666',
};

const TYPE_LABELS = {
    model:    '3D MODEL',
    texture:  'TEXTURE',
    audio:    'AUDIO',
    material: 'MATERIAL',
    scene:    'SCENE',
    other:    'ASSET',
};

function addAssetEntry(data) {
    if (seenAssets.has(data.name)) return;
    seenAssets.add(data.name);
    totalAssets++;
    assetCount.textContent = totalAssets;

    const color = TYPE_COLORS[data.assetType] || TYPE_COLORS.other;
    const label = TYPE_LABELS[data.assetType] || 'ASSET';
    const li = document.createElement('li');
    li.innerHTML = `
        <div class="asset-info">
            <span class="asset-badge" style="background:${color}20;color:${color};border-color:${color}40">${label}</span>
            <span class="asset-name">${escHtml(data.name)}</span>
            <span class="asset-meta">Offset: 0x${data.offset.toString(16).toUpperCase()}</span>
        </div>
    `;
    assetList.appendChild(li);
}

function addModelEntry(data) {
    if (seenModels.has(data.name)) return;
    seenModels.add(data.name);
    totalModels++;
    modelCount.textContent = totalModels;
    noModelsMsg.classList.add('hidden');

    const ext = data.ext ? data.ext.replace('.', '').toUpperCase() : '?';
    const li = document.createElement('li');
    li.className = 'model-entry';
    li.dataset.name = data.name;

    if (data.viewable) {
        li.innerHTML = `
            <div class="asset-info">
                <span class="asset-badge model-badge">${ext}</span>
                <span class="asset-name">${escHtml(data.name)}</span>
                <span class="asset-meta">Offset: 0x${data.offset.toString(16).toUpperCase()}</span>
            </div>
            <button class="btn-view" onclick="requestModelView('${escAttr(data.name)}', ${data.offset})">VIEW</button>
        `;
    } else {
        li.innerHTML = `
            <div class="asset-info">
                <span class="asset-badge model-badge">${ext}</span>
                <span class="asset-name">${escHtml(data.name)}</span>
                <span class="asset-meta">Offset: 0x${data.offset.toString(16).toUpperCase()} · Packed (UnityFS)</span>
            </div>
            <button class="btn-view btn-packed" title="Asset is compressed inside UnityFS bundle. Wasm decompressor required.">PACKED</button>
        `;
    }

    modelList.appendChild(li);
}

// Called from inline onclick — needs to be global
window.requestModelView = function(name, offset) {
    addLog(`Requesting model view: ${name}`, 'system');
    statusText.innerText = `Extracting ${name}...`;
    // Signal the worker to extract the raw OBJ at this offset
    worker.postMessage({ type: 'EXTRACT_MODEL', name, offset });
};

// ============================================================
// WORKER
// ============================================================
let worker;
try {
    worker = new Worker('js/worker.js');
    addLog('Background parsing thread spawned.', 'system');
} catch (e) {
    addLog(`Failed to spawn worker: ${e.message}`, 'error');
}

worker.onmessage = function(e) {
    const { type, data, logType } = e.data;

    switch (type) {
        case 'LOG':
            addLog(data, logType || 'normal');
            statusText.innerText = data.length > 80 ? data.slice(0, 80) + '…' : data;
            break;

        case 'PROGRESS':
            progressBar.value = data;
            break;

        case 'ASSET_FOUND_META':
            addAssetEntry(data);
            break;

        case 'MODEL_FOUND':
            addModelEntry(data);
            // Switch to Models tab automatically when first model found
            if (totalModels === 1) {
                switchTab('models');
            }
            break;

        case 'SCAN_COMPLETE':
            progressBar.value = 100;
            addLog(`Scan finished. ${totalModels} model(s), ${totalAssets} total assets detected.`, 'success');
            statusText.innerText = `Done. ${totalModels} model(s) found.`;
            if (totalModels === 0) {
                noModelsMsg.classList.remove('hidden');
                noModelsMsg.textContent = 'No 3D models detected in this archive. The APK may use proprietary or encrypted bundles.';
            }
            break;

        case 'MODEL_DATA':
            // Worker extracted raw OBJ text from the file
            if (data.objText) {
                loadObjText(data.objText, data.name);
            } else {
                addLog(`Could not extract model data for: ${data.name}`, 'error');
            }
            break;

        default:
            break;
    }
};

worker.onerror = function(error) {
    addLog(`Worker Error: ${error.message}`, 'error');
};

// ============================================================
// FILE INPUT
// ============================================================
const fileInput = document.getElementById('apk-upload');
fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Reset state
    terminal.innerHTML = '';
    assetList.innerHTML = '';
    modelList.innerHTML = '';
    totalAssets = 0;
    totalModels = 0;
    seenAssets.clear();
    seenModels.clear();
    assetCount.textContent = '0';
    modelCount.textContent = '0';
    modelStats.classList.add('hidden');
    noModelsMsg.classList.remove('hidden');
    noModelsMsg.textContent = 'Scanning archive for 3D models…';
    progressBar.value = 0;

    if (currentModel) {
        scene.remove(currentModel);
        currentModel = null;
    }

    addLog(`MOUNTED: ${file.name}`, 'success');
    addLog(`SIZE: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    statusText.innerText = 'Scanning…';

    switchTab('logs');
    worker.postMessage({ type: 'PROCESS_FILE', file });
    event.target.value = '';
});

// ============================================================
// HELPERS
// ============================================================
function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
    return s.replace(/'/g,"\\'");
}

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// --- Viewport Setup ---
const container = document.getElementById('viewport-container');
const canvas = document.getElementById('viewer-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 15, 10);
scene.add(dirLight);
scene.add(new THREE.GridHelper(20, 20, 0x333333, 0x222222));

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

// Double tap for wireframe
let isWireframe = false;
canvas.addEventListener('dblclick', () => {
    if (currentModel) {
        isWireframe = !isWireframe;
        currentModel.traverse((child) => {
            if (child.isMesh) {
                child.material.wireframe = isWireframe;
            }
        });
    }
});

// --- UI Binding ---
const terminal = document.getElementById('terminal-log');
const logContainer = document.getElementById('tab-logs');
const statusText = document.getElementById('status-text');

function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    
    div.innerText = `[${timeStr}] ${msg}`;
    terminal.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// --- Global UI Window Functions ---
window.extractedModels = new Map();

window.viewMesh = function(name) {
    const modelData = window.extractedModels.get(name);
    if (!modelData) return;

    const loader = new OBJLoader();
    const object = loader.parse(modelData.objText);

    if (currentModel) scene.remove(currentModel);

    const material = new THREE.MeshStandardMaterial({ 
        color: 0x00e676, 
        side: THREE.DoubleSide,
        roughness: 0.5,
        metalness: 0.2
    });
    
    object.traverse((child) => {
        if (child.isMesh) {
            child.material = material;
            child.geometry.computeBoundingBox();
            const center = new THREE.Vector3();
            child.geometry.boundingBox.getCenter(center);
            child.geometry.translate(-center.x, -center.y, -center.z);
        }
    });

    scene.add(object);
    currentModel = object;

    camera.position.set(0, 5, 10);
    controls.target.set(0, 0, 0);
    controls.update();

    const statsUI = document.getElementById('model-stats');
    statsUI.classList.remove('hidden');
    document.getElementById('stat-name').innerText = name;
    document.getElementById('stat-verts').innerText = `V: ${modelData.vertexCount}`;
    document.getElementById('stat-faces').innerText = `F: ${modelData.faceCount}`;
};

window.saveMesh = function(name) {
    const modelData = window.extractedModels.get(name);
    if (!modelData) return;
    
    const blob = new Blob([modelData.objText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.obj`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

window.saveAllModels = function() {
    if (!window.extractedModels || window.extractedModels.size === 0) return;
    addLog(`Initiating download for ${window.extractedModels.size} models...`, 'system');
    
    window.extractedModels.forEach((modelData, name) => {
        window.saveMesh(name);
    });
};

// --- Worker Setup ---
let worker;
try {
    worker = new Worker('js/worker.js');
    addLog('Background parsing thread spawned.', 'system');
} catch (e) {
    addLog(`Failed to spawn worker: ${e.message}`, 'error');
}

let assetCount = 0;
const uniqueAssets = new Set(); 

worker.onmessage = function(e) {
    const { type, data, logType } = e.data;
    
    if (type === 'LOG') {
        addLog(data, logType || 'normal');
        statusText.innerText = data;
    } else if (type === 'PROGRESS') {
        document.getElementById('progress-bar').value = data;
    } else if (type === 'ASSET_FOUND_META') {
        if (!uniqueAssets.has(data.name)) {
            uniqueAssets.add(data.name);
            assetCount++;
            document.getElementById('asset-count').innerText = assetCount;
            
            let typeTag = "UNKNOWN";
            let tagColor = "#888";
            const lowerName = data.name.toLowerCase();
            if (lowerName.includes('.mesh')) { typeTag = "MESH"; tagColor = "#00e676"; }
            else if (lowerName.includes('.tex') || lowerName.includes('.png')) { typeTag = "TEXTURE"; tagColor = "#29b6f6"; }
            else if (lowerName.includes('.mat')) { typeTag = "MATERIAL"; tagColor = "#ffca28"; }
            else if (data.name.startsWith('CAB-')) { typeTag = "CABINET"; tagColor = "#ab47bc"; }
            else if (data.assetType === 'bundle') { typeTag = "BUNDLE"; tagColor = "#f44336"; }

            const li = document.createElement('li');
            li.innerHTML = `
                <div class="asset-info">
                    <span class="asset-name" style="color: ${tagColor}">[${typeTag}] ${data.name}</span>
                    <span class="asset-meta">Offset: 0x${data.offset.toString(16).toUpperCase()}</span>
                </div>
            `;
            document.getElementById('asset-list').appendChild(li);
        }
    } else if (type === 'MODEL_FOUND') {
        const { name, sourceName, vertexCount, faceCount, objText } = data;

        const li = document.createElement('li');
        li.className = 'model-card';
        li.innerHTML = `
            <div class="mc-info">
                <span class="mc-badge">OBJ</span>
                <span class="mc-name">${name}</span>
                <span class="mc-meta">V: ${vertexCount} · F: ${faceCount}</span>
                <span class="mc-src">${sourceName}</span>
            </div>
            <div class="mc-actions">
                <button class="btn-view" onclick="window.viewMesh('${name}')">VIEW 3D</button>
                <button class="btn-save" onclick="window.saveMesh('${name}')">SAVE</button>
            </div>
        `;
        document.getElementById('model-list').appendChild(li);

        const modelCountEl = document.getElementById('model-count');
        modelCountEl.innerText = parseInt(modelCountEl.innerText) + 1;

        window.extractedModels.set(name, { objText, vertexCount, faceCount });

        document.getElementById('no-models-msg').style.display = 'none';
        document.getElementById('save-all-btn').style.display = 'inline-flex';

    } else if (type === 'SCAN_COMPLETE') {
        statusText.innerText = `Complete: ${data.modelCount} mesh(es), ${data.assetCount} assets.`;
        document.getElementById('progress-bar').value = 100;
    }
};

worker.onerror = function(error) {
    addLog(`Worker Error: ${error.message}`, 'error');
};

// --- File Handling ---
const fileInput = document.getElementById('apk-upload');
fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    terminal.innerHTML = '';
    document.getElementById('asset-list').innerHTML = '';
    document.getElementById('model-list').innerHTML = '';
    document.getElementById('no-models-msg').style.display = 'block';
    document.getElementById('save-all-btn').style.display = 'none';
    
    assetCount = 0;
    uniqueAssets.clear();
    window.extractedModels.clear();
    document.getElementById('asset-count').innerText = "0";
    document.getElementById('model-count').innerText = "0";
    
    addLog(`MOUNTED: ${file.name}`, 'success');
    addLog(`SIZE: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    statusText.innerText = "Initiating Stream...";
    
    worker.postMessage({ type: 'PROCESS_FILE', file: file });
    event.target.value = ''; 
});

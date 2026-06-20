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

// --- UI Binding ---
const terminal = document.getElementById('terminal-log');
const logContainer = document.getElementById('tab-logs');
const statusText = document.getElementById('status-text');
const fileInput = document.getElementById('apk-upload');

// Lock the file input until WASM is ready
fileInput.disabled = true;

function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    div.innerText = `[${timeStr}] ${msg}`;
    terminal.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
}

let worker;
try {
    worker = new Worker('js/worker.js');
    addLog('Background thread spawned. Waiting for WASM Engine...', 'system');
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
    } else if (type === 'WASM_READY') {
        // Unlock the UI!
        fileInput.disabled = false;
        document.querySelector('.custom-file-upload').style.backgroundColor = '#00e676';
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

            const li = document.createElement('li');
            li.innerHTML = `
                <div class="asset-info">
                    <span class="asset-name" style="color: ${tagColor}">[${typeTag}] ${data.name}</span>
                    <span class="asset-meta">Memory Offset: 0x${data.offset.toString(16).toUpperCase()}</span>
                </div>
            `;
            document.getElementById('asset-list').appendChild(li);
        }
    }
};

worker.onerror = function(error) {
    addLog(`Worker Error: ${error.message}`, 'error');
};

fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    terminal.innerHTML = '';
    document.getElementById('asset-list').innerHTML = '';
    assetCount = 0;
    uniqueAssets.clear();
    document.getElementById('asset-count').innerText = "0";
    
    addLog(`MOUNTED: ${file.name}`, 'success');
    addLog(`SIZE: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'system');
    statusText.innerText = "Initiating Stream...";
    
    worker.postMessage({ type: 'PROCESS_FILE', file: file });
    event.target.value = ''; 
});

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// --- Viewport Setup ---
const container = document.getElementById('viewport-container');
const canvas = document.getElementById('viewer-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(10, 15, 10);
scene.add(dirLight);
scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));

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

// --- UI Binding ---
const objLoader = new OBJLoader();
const statsPanel = document.getElementById('model-stats');
const terminal = document.getElementById('terminal-log');
const logContainer = document.getElementById('tab-logs');

function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    terminal.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight; // Auto-scroll
}

function loadModelToViewport(objBlobUrl, verts, faces) {
    if (currentModel) scene.remove(currentModel);
    addLog(`Loading model to viewport...`, 'system');

    objLoader.load(objBlobUrl, (object) => {
        currentModel = object;
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        scene.add(object);

        statsPanel.classList.remove('hidden');
        document.getElementById('stat-verts').innerText = `V: ${verts}`;
        document.getElementById('stat-faces').innerText = `F: ${faces}`;
        addLog(`Model rendered successfully.`, 'success');
    });
}

// --- Worker Setup ---
const worker = new Worker('js/worker.js');
let assetCount = 0;

worker.onmessage = function(e) {
    const { type, data, logType } = e.data;
    
    if (type === 'LOG') {
        addLog(data, logType || 'normal');
        document.getElementById('status-text').innerText = data;
    } else if (type === 'PROGRESS') {
        document.getElementById('progress-bar').value = data;
    } else if (type === 'ASSET_FOUND') {
        assetCount++;
        document.getElementById('asset-count').innerText = assetCount;
        
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="asset-info">
                <span class="asset-name">${data.name}</span>
                <span class="asset-meta">V: ${data.verts} | F: ${data.faces}</span>
            </div>
            <button class="btn-view" data-url="${data.blobUrl}" data-v="${data.verts}" data-f="${data.faces}">View</button>
        `;
        li.querySelector('.btn-view').addEventListener('click', (ev) => {
            loadModelToViewport(ev.target.getAttribute('data-url'), ev.target.getAttribute('data-v'), ev.target.getAttribute('data-f'));
        });
        document.getElementById('asset-list').appendChild(li);
    }
};

// --- File Handling ---
document.getElementById('apk-upload').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    terminal.innerHTML = ''; // Clear logs
    document.getElementById('asset-list').innerHTML = '';
    assetCount = 0;
    document.getElementById('asset-count').innerText = "0";
    
    addLog(`File selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'system');
    
    // Pass the File object directly, DO NOT use arrayBuffer() here!
    worker.postMessage({ type: 'PROCESS_FILE', file: file });
});

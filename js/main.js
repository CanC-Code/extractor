// js/main.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/jsm/loaders/OBJLoader.js';

// --- Three.js Setup ---
const container = document.getElementById('viewport-container');
const canvas = document.getElementById('viewer-canvas');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 5, 15);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 15, 10);
scene.add(dirLight);
scene.add(new THREE.GridHelper(30, 30, 0x333333, 0x222222));

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

// --- UI Helpers ---
const terminal = document.getElementById('terminal-log');
const assetList = document.getElementById('asset-list');
const statusText = document.getElementById('status-text');
let assetCount = 0;
const uniqueAssets = new Set();

function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    div.innerHTML = `<span class="text-gray-500">[${time}]</span> ${msg}`;
    if (type === 'success') div.style.color = '#4ade80';
    if (type === 'error') div.style.color = '#f87171';
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
}

// --- Worker ---
let worker;
try {
    worker = new Worker('js/worker.js');
    addLog('Worker thread started', 'success');
} catch (e) {
    addLog(`Worker failed: ${e.message}`, 'error');
}

worker.onmessage = function(e) {
    const { type, data, logType } = e.data;

    if (type === 'LOG') {
        addLog(data, logType);
        statusText.textContent = data;
    } 
    else if (type === 'PROGRESS') {
        document.getElementById('progress-bar').value = data;
    } 
    else if (type === 'ASSET_FOUND_META') {
        if (uniqueAssets.has(data.name)) return;
        uniqueAssets.add(data.name);
        assetCount++;
        document.getElementById('asset-count').textContent = assetCount;

        const li = document.createElement('li');
        li.className = "flex justify-between items-center bg-gray-800 p-3 rounded-lg";
        li.innerHTML = `
            <div>
                <span class="font-medium">${data.name}</span><br>
                <span class="text-xs text-gray-500">0x${data.offset.toString(16).toUpperCase()}</span>
            </div>
            <button class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm">View</button>
        `;
        assetList.appendChild(li);
    }
};

worker.onerror = (err) => addLog(`Worker Error: ${err.message}`, 'error');

// --- File Handling ---
document.getElementById('apk-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Reset UI
    terminal.innerHTML = '';
    assetList.innerHTML = '';
    uniqueAssets.clear();
    assetCount = 0;
    document.getElementById('asset-count').textContent = '0';

    addLog(`Loaded: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`, 'success');

    worker.postMessage({ type: 'PROCESS_FILE', file: file });
});
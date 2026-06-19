// js/main.js
console.log("🚀 main.js initialized with 3D support");

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const logs = document.getElementById('logs');
const modelList = document.getElementById('modelList');
const assetList = document.getElementById('assetList');
const canvas = document.getElementById('renderCanvas');

// Three.js State
let scene, camera, renderer;

let worker = null;
const seen = new Set();

/**
 * Initialize 3D Viewport
 */
function initThree() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    camera.position.z = 5;

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(1, 1, 1);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x404040));

    function animate() {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    animate();
}

/**
 * Preview Model in Viewport
 * Placeholder for loading logic
 */
function previewModel(name) {
    log(`Loading model: ${name}...`, 'info');
    // Clear existing models
    scene.children.filter(c => c.type === 'Mesh').forEach(m => scene.remove(m));
    
    // Add dummy cube as placeholder for the model logic
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshPhongMaterial({ color: 0x4f46e5 });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    
    log(`Model ${name} displayed in viewport`, 'success');
}

/**
 * Appends a log entry to the UI.
 */
function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-red-400' : 'text-zinc-400';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

/**
 * Initializes the Web Worker.
 */
function initWorker() {
    try {
        worker = new Worker('js/worker.js');
        worker.onmessage = (e) => {
            const { type, data } = e.data;
            if (type === 'LOG') log(data, e.data.logType);
            else if (type === 'ASSET_FOUND_META') handleAssetDiscovery(data);
        };
    } catch (err) { log(`Worker error: ${err.message}`, 'error'); }
}

/**
 * Routes assets to UI and adds functionality
 */
function handleAssetDiscovery(data) {
    if (seen.has(data.name)) return;
    seen.add(data.name);

    const isModel = data.name.match(/\.(mesh|fbx|obj|prefab)$/i);
    const item = document.createElement('li');
    item.className = "p-2 border-b border-zinc-800 text-xs flex justify-between items-center hover:bg-zinc-800";
    
    item.innerHTML = `
        <span class="text-amber-300 truncate">${data.name}</span>
        <button class="px-2 py-1 ${isModel ? 'bg-amber-600' : 'bg-zinc-700'} hover:opacity-80 rounded text-[10px]">
            ${isModel ? 'Preview' : 'Extract'}
        </button>
    `;

    item.querySelector('button').onclick = () => {
        if (isModel) previewModel(data.name);
        else log(`Extraction triggered: ${data.name}`);
    };

    if (isModel) modelList.appendChild(item);
    else assetList.appendChild(item);
}

/**
 * File Handling
 */
function handleFile(file) {
    logs.innerHTML = '';
    modelList.innerHTML = '';
    assetList.innerHTML = '';
    seen.clear();
    log(`Processing: ${file.name}`, 'success');
    worker.postMessage({ type: 'PROCESS_FILE', file: file });
}

// Event Listeners
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// Init
initThree();
initWorker();
log("✅ Ready. Drop an APK to begin.", "success");

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
let isWorkerReady = false;
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
 */
function previewModel(name) {
    log(`Loading model: ${name}...`, 'info');
    
    // Clear existing models
    scene.children.filter(c => c.type === 'Mesh').forEach(m => scene.remove(m));

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshPhongMaterial({ color: 0x4f46e5 });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);

    log(`Model ${name} placeholder displayed in viewport`, 'success');
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
 * Initializes the Web Worker and sets up the strict command-response protocol.
 */
function initWorker() {
    try {
        worker = new Worker('js/worker.js');
        
        // Catch critical network errors (like 404 for worker.js itself)
        worker.onerror = (err) => {
            log(`Critical Worker Error: ${err.message || 'Failed to load worker script (check console)'}`, 'error');
        };

        worker.onmessage = (e) => {
            const response = e.data;
            
            if (response.type === 'READY') {
                isWorkerReady = true;
                log("WASM Runtime initialized and worker ready.", "success");
            } 
            else if (response.type === 'SUCCESS') {
                if (response.command === 'process_unity_archive') {
                    log("Archive processing complete.", "success");
                } else if (response.command === 'deinterleave_mesh') {
                    log("Mesh deinterleaved successfully.", "success");
                    console.log("OBJ Data:", response.result);
                }
            } 
            else if (response.type === 'ERROR') {
                log(`Worker execution error: ${response.error}`, "error");
            }
            else if (response.type === 'LOG') {
                log(response.data, response.logType);
            } 
            else if (response.type === 'ASSET_FOUND_META') {
                handleAssetDiscovery(response.data);
            }
        };
    } catch (err) { 
        log(`Worker initialization error: ${err.message}`, 'error'); 
    }
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
 * File Handling: Reads the file into an ArrayBuffer and passes it to the WASM worker
 */
function handleFile(file) {
    if (!isWorkerReady) {
        log(`Cannot process ${file.name}. WebAssembly environment is still loading or failed to load. Check logs above.`, 'error');
        return;
    }

    logs.innerHTML = '';
    modelList.innerHTML = '';
    assetList.innerHTML = '';
    seen.clear();
    
    log(`Reading file: ${file.name} (${file.size} bytes)`, 'info');
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        log(`File read to memory. Sending to WASM worker...`, 'info');
        const arrayBuffer = e.target.result;
        const uint8View = new Uint8Array(arrayBuffer);
        
        worker.postMessage({ 
            command: 'process_unity_archive', 
            payload: {
                fileData: uint8View
            }
        });
    };
    
    reader.onerror = function() {
        log(`Failed to read file: ${file.name}`, 'error');
    };

    reader.readAsArrayBuffer(file);
}

// Event Listeners
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { 
    if (e.target.files[0]) handleFile(e.target.files[0]); 
    // Reset the input value so the same file can be selected again sequentially
    e.target.value = ''; 
});
dropZone.addEventListener('dragover', e => { 
    e.preventDefault(); 
    dropZone.classList.add('dragover'); 
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// Init
initThree();
initWorker();
log("✅ Ready. Drop an APK or Unity bundle to begin.", "success");

console.log("🚀 main.js initialized with 3D viewport support");

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const logs = document.getElementById('logs');
const modelList = document.getElementById('modelList');
const assetList = document.getElementById('assetList');
const canvas = document.getElementById('renderCanvas');
const statusBadge = document.getElementById('status-badge');

let worker = null;
const seen = new Set();
let currentFile = null;

// Three.js Core Components
let scene, camera, renderer, currentModelMesh;

function initThree() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.position.set(0, 1, 5);

    // Lighting setup for smooth-shaded geometry
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 7.5);
    scene.add(dirLight);
    
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    scene.add(ambientLight);

    // Basic animation loop
    function animate() {
        requestAnimationFrame(animate);
        if (currentModelMesh) {
            currentModelMesh.rotation.y += 0.005;
        }
        renderer.render(scene, camera);
    }
    animate();

    // Handle window resize
    window.addEventListener('resize', () => {
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    });
}

function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-red-400' : 'text-zinc-400';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

function initWorker() {
    try {
        worker = new Worker('js/worker.js');
        worker.onmessage = (e) => {
            const { type, data, logType } = e.data;

            if (type === 'LOG') {
                log(data, logType);
            } else if (type === 'ASSET_FOUND_META') {
                handleAssetDiscovery(data);
            } else if (type === 'ASSET_EXTRACTED') {
                handleExtractedAsset(data);
            }
        };
        log('Background worker ready', 'success');
    } catch (err) { 
        log(`Failed to create worker: ${err.message}`, 'error'); 
    }
}

function handleAssetDiscovery(data) {
    if (seen.has(data.name)) return;
    seen.add(data.name);

    // Identify if the asset is a 3D model format
    const isModel = data.name.match(/\.(mesh|fbx|obj|prefab)$/i);
    const listTarget = isModel ? modelList : assetList;

    const item = document.createElement('li');
    item.className = "p-2 border-b border-zinc-800 text-[10px] flex justify-between items-center hover:bg-zinc-800 transition-colors rounded";
    
    item.innerHTML = `
        <div class="flex flex-col truncate pr-2">
            <span class="${isModel ? 'text-emerald-300' : 'text-amber-300'} font-semibold truncate">${data.name}</span>
            <span class="text-zinc-500">Offset: 0x${(data.offset || 0).toString(16).toUpperCase()}</span>
        </div>
        <button class="px-3 py-1.5 ${isModel ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-zinc-700 hover:bg-blue-600'} rounded font-bold transition-colors shadow-sm whitespace-nowrap">
            ${isModel ? 'PREVIEW' : 'EXTRACT'}
        </button>
    `;

    item.querySelector('button').onclick = () => {
        log(`Requesting extraction for: ${data.name}`);
        statusBadge.textContent = 'EXTRACTING...';
        statusBadge.className = "bg-amber-900/80 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] border border-amber-700 uppercase tracking-widest text-amber-400";
        
        worker.postMessage({ 
            type: 'EXTRACT_ASSET', 
            assetMeta: data,
            file: currentFile 
        });
    };

    listTarget.appendChild(item);
}

function handleExtractedAsset(data) {
    const { name, buffer, isModel } = data;
    log(`Successfully extracted ${name} (${buffer.byteLength} bytes)`, 'success');
    statusBadge.textContent = 'SYSTEM IDLE';
    statusBadge.className = "bg-zinc-900/80 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] border border-zinc-700 uppercase tracking-widest text-zinc-400";

    if (isModel) {
        // Here we pass the buffer to Three.js or the WASM geometry de-interleaver
        renderPlaceholderModel(name); 
    } else {
        // Trigger generic file download
        const blob = new Blob([buffer]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }
}

// Temporary placeholder until WASM geometry parsing is hooked into the buffer
function renderPlaceholderModel(name) {
    if (currentModelMesh) scene.remove(currentModelMesh);
    
    const geometry = new THREE.TorusKnotGeometry(1, 0.3, 100, 16);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x10b981, 
        roughness: 0.4, 
        metalness: 0.2,
        wireframe: false
    });
    
    currentModelMesh = new THREE.Mesh(geometry, material);
    scene.add(currentModelMesh);
    log(`Rendering generated mesh for ${name}`, 'success');
}

function handleFile(file) {
    if (!file) return;
    currentFile = file;

    logs.innerHTML = '';
    modelList.innerHTML = '';
    assetList.innerHTML = '';
    seen.clear();
    
    if (currentModelMesh) scene.remove(currentModelMesh);

    log(`Mounted: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
    statusBadge.textContent = 'SCANNING APK...';
    
    if (worker) {
        worker.postMessage({ type: 'PROCESS_FILE', file: file });
    }
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

// Initialization sequence
initThree();
initWorker();

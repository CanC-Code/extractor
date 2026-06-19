import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// --- Viewport Setup ---
const canvas = document.getElementById('viewer-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(0, 2, 5);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// Grid Helper
const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
scene.add(gridHelper);

let currentModel = null;

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// Handle Window Resize
window.addEventListener('resize', () => {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
});

// --- Asset Loader Logic ---
const objLoader = new OBJLoader();

function loadModelToViewport(objBlobUrl) {
    if (currentModel) {
        scene.remove(currentModel);
        currentModel = null;
    }

    objLoader.load(objBlobUrl, (object) => {
        currentModel = object;
        
        // Center the model
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        
        scene.add(object);
    }, 
    (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% loaded'),
    (error) => console.error('An error happened loading the OBJ', error));
}

// --- Background Worker Setup ---
const worker = new Worker('js/worker.js');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const assetList = document.getElementById('asset-list');

worker.onmessage = function(e) {
    const { type, data } = e.data;
    
    if (type === 'STATUS') {
        statusText.innerText = data;
    } else if (type === 'PROGRESS') {
        progressBar.value = data;
    } else if (type === 'ASSET_FOUND') {
        // data contains { name: string, blobUrl: string }
        addAssetToList(data.name, data.blobUrl);
    } else if (type === 'COMPLETE') {
        statusText.innerText = 'Extraction Complete';
        progressBar.value = 100;
    }
};

function addAssetToList(name, blobUrl) {
    const li = document.createElement('li');
    li.innerHTML = `
        <span class="asset-name">${name}</span>
        <div class="actions">
            <button class="btn-view" data-url="${blobUrl}">View</button>
            <a href="${blobUrl}" download="${name}.obj" class="btn-download">Save</a>
        </div>
    `;
    
    li.querySelector('.btn-view').addEventListener('click', (e) => {
        loadModelToViewport(e.target.getAttribute('data-url'));
    });
    
    assetList.appendChild(li);
}

// --- File Input Handling ---
document.getElementById('apk-upload').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    statusText.innerText = 'Reading file to memory...';
    progressBar.value = 0;
    assetList.innerHTML = ''; // Clear previous

    // For massive files, send as stream or ArrayBuffer to worker
    const arrayBuffer = await file.arrayBuffer();
    worker.postMessage({ type: 'PROCESS_FILE', buffer: arrayBuffer }, [arrayBuffer]);
});

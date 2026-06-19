import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// --- Viewport Setup ---
const canvas = document.getElementById('viewer-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);
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
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
});

// --- Asset Loader Logic ---
const objLoader = new OBJLoader();
const statsPanel = document.getElementById('model-stats');

function loadModelToViewport(objBlobUrl, verts, faces) {
    if (currentModel) { scene.remove(currentModel); }

    objLoader.load(objBlobUrl, (object) => {
        currentModel = object;
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        scene.add(object);

        // Update UI Stats
        statsPanel.classList.remove('hidden');
        document.getElementById('stat-verts').innerText = `Verts: ${verts}`;
        document.getElementById('stat-faces').innerText = `Faces: ${faces}`;
    });
}

// --- Background Worker Setup ---
const worker = new Worker('js/worker.js');
let foundCount = 0;

worker.onmessage = function(e) {
    const { type, data } = e.data;
    
    if (type === 'STATUS') {
        document.getElementById('status-text').innerText = data;
    } else if (type === 'PROGRESS') {
        document.getElementById('progress-bar').value = data;
    } else if (type === 'ARCHIVE_INFO') {
        document.getElementById('archive-info').classList.remove('hidden');
        document.getElementById('meta-sig').innerText = data.signature;
        document.getElementById('meta-ver').innerText = data.unityVersion;
        document.getElementById('meta-size').innerText = (data.fileSize / 1024 / 1024).toFixed(2) + ' MB';
    } else if (type === 'ASSET_FOUND') {
        foundCount++;
        document.getElementById('meta-count').innerText = foundCount;
        addAssetToList(data);
    } else if (type === 'COMPLETE') {
        document.getElementById('status-text').innerText = 'Extraction Complete';
        document.getElementById('progress-bar').value = 100;
    } else if (type === 'ERROR') {
        document.getElementById('status-text').innerText = `Error: ${data}`;
        document.getElementById('status-text').style.color = "red";
    }
};

function addAssetToList(asset) {
    const li = document.createElement('li');
    li.innerHTML = `
        <div class="asset-header">
            <strong>${asset.name}</strong>
            <div class="actions">
                <button class="btn-view" data-url="${asset.blobUrl}" data-v="${asset.verts}" data-f="${asset.faces}">View</button>
                <a href="${asset.blobUrl}" download="${asset.name}.obj" class="btn-download">Save</a>
            </div>
        </div>
        <div class="asset-meta">Vertices: ${asset.verts} | Faces: ${asset.faces}</div>
    `;
    
    li.querySelector('.btn-view').addEventListener('click', (e) => {
        const btn = e.target;
        loadModelToViewport(btn.getAttribute('data-url'), btn.getAttribute('data-v'), btn.getAttribute('data-f'));
    });
    document.getElementById('asset-list').appendChild(li);
}

document.getElementById('apk-upload').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    foundCount = 0;
    document.getElementById('asset-list').innerHTML = '';
    document.getElementById('archive-info').classList.add('hidden');
    statsPanel.classList.add('hidden');

    const arrayBuffer = await file.arrayBuffer();
    worker.postMessage({ type: 'PROCESS_FILE', buffer: arrayBuffer }, [arrayBuffer]);
});

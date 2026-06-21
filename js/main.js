// =============================================
// Global State
// =============================================
let currentFile = null;
let currentFileSize = 0;
let currentProgress = 0;
let models = [];
let assets = [];
let scene, camera, renderer, mesh;
let isWasmReady = false;

// =============================================
// WASM Module Initialization
// =============================================
window.Module = {
    onRuntimeInitialized: function() {
        console.log("WASM module loaded and ready!");
        isWasmReady = true;
        updateStatus("WASM module loaded — ready to process files.");
        initThreeJS();
        setupEventListeners();
    },
    onAbort: function(what) {
        console.error("WASM module failed to load:", what);
        updateStatus("Error: WASM module failed to load.");
    }
};

// =============================================
// Three.js Setup
// =============================================
function initThreeJS() {
    const canvas = document.getElementById("renderCanvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    // Add directional light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Handle window resize
    window.addEventListener("resize", () => {
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    });

    // Start animation loop
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    if (mesh) mesh.rotation.y += 0.005;
    renderer.render(scene, camera);
}

// =============================================
// Event Listeners
// =============================================
function setupEventListeners() {
    // File input
    const fileInput = document.getElementById("fileInput");
    fileInput.addEventListener("change", handleFileUpload);

    // Drag and drop
    const dropZone = document.getElementById("dropZone");
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("border-blue-400", "bg-zinc-800");
    });
    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("border-blue-400", "bg-zinc-800");
    });
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("border-blue-400", "bg-zinc-800");
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFileUpload();
        }
    });
}

// =============================================
// File Handling
// =============================================
function handleFileUpload() {
    const fileInput = document.getElementById("fileInput");
    const file = fileInput.files[0];
    if (!file) return;

    if (!isWasmReady) {
        updateStatus("Error: WASM module not ready. Please wait and try again.");
        logMessage("Error: WASM module not ready.");
        return;
    }

    currentFile = file;
    currentFileSize = file.size;
    currentProgress = 0;
    updateStatus(`Loading ${file.name}...`);
    logMessage(`Starting extraction of ${file.name} (${formatFileSize(file.size)})`);

    // Reset UI
    document.getElementById("modelList").innerHTML = "";
    document.getElementById("assetList").innerHTML = "";
    document.getElementById("scanCount").textContent = "0 found";
    document.getElementById("modelCount").textContent = "0";
    document.getElementById("assetCount").textContent = "0";
    models = [];
    assets = [];

    // Read file as ArrayBuffer
    const reader = new FileReader();
    reader.onload = (e) => {
        const arrayBuffer = e.target.result;
        const uint8Array = new Uint8Array(arrayBuffer);
        processUnityArchive(uint8Array);
    };
    reader.onerror = () => {
        updateStatus("Error: Failed to read file.");
        logMessage("Error: Failed to read file.");
    };
    reader.readAsArrayBuffer(file);
}

// =============================================
// WASM Integration
// =============================================
function processUnityArchive(buffer) {
    updateStatus("Processing Unity archive...");
    logMessage("Processing Unity archive...");

    try {
        // Allocate memory in WASM for the buffer
        const bufferPtr = Module._malloc(buffer.length);
        if (!bufferPtr) {
            throw new Error("Failed to allocate memory in WASM.");
        }

        // Copy the buffer to WASM memory
        Module.HEAPU8.set(buffer, bufferPtr);

        // Call the WASM function to process the archive
        Module._process_unity_archive(bufferPtr, buffer.length);

        // Free the allocated memory
        Module._free(bufferPtr);

        // Simulate progress (replace with actual progress updates from WASM)
        simulateProgress();

        // For demo purposes, add mock models and assets
        // Replace this with actual data from WASM
        models = [
            { name: "Model_1", vertices: 1000, faces: 500 },
            { name: "Model_2", vertices: 2000, faces: 1000 },
        ];
        assets = [
            { name: "Texture_1", type: "Texture", size: "1024x1024" },
            { name: "Material_1", type: "Material", size: "N/A" },
        ];

        updateUI();
        updateStatus("Extraction complete!");
        logMessage("Extraction complete. Found 2 models and 2 assets.");
    } catch (e) {
        console.error("Error processing Unity archive:", e);
        updateStatus("Error: Failed to process Unity archive.");
        logMessage(`Error: ${e.message}`);
    }
}

// =============================================
// UI Updates
// =============================================
function updateStatus(text) {
    document.getElementById("statusText").textContent = text;
    document.getElementById("statusBadge").textContent = text.split(" — ")[0] || "Idle";
}

function logMessage(message) {
    const logsDiv = document.getElementById("logs");
    const logEntry = document.createElement("div");
    logEntry.textContent = message;
    logsDiv.appendChild(logEntry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
}

function updateUI() {
    // Update model list
    const modelList = document.getElementById("modelList");
    models.forEach((model, index) => {
        const li = document.createElement("li");
        li.innerHTML = `
            <button class="w-full text-left p-1 rounded hover:bg-zinc-800 transition" onclick="loadModel(${index})">
                ${model.name} (${model.vertices} vertices, ${model.faces} faces)
            </button>
        `;
        modelList.appendChild(li);
    });
    document.getElementById("modelCount").textContent = models.length;
    document.getElementById("scanCount").textContent = `${models.length} found`;

    // Update asset list
    const assetList = document.getElementById("assetList");
    assets.forEach((asset) => {
        const li = document.createElement("li");
        li.innerHTML = `
            <div class="p-1 rounded hover:bg-zinc-800 transition">
                ${asset.name} (${asset.type})
            </div>
        `;
        assetList.appendChild(li);
    });
    document.getElementById("assetCount").textContent = assets.length;

    // Show save button if models exist
    const saveAllBtn = document.getElementById("saveAllBtn");
    saveAllBtn.classList.toggle("hidden", models.length === 0);
    saveAllBtn.onclick = saveAllModels;
}

// =============================================
// Progress Simulation (Replace with actual WASM progress)
// =============================================
function simulateProgress() {
    const progressBar = document.getElementById("progressBar");
    const interval = setInterval(() => {
        currentProgress += 10;
        progressBar.value = currentProgress;
        if (currentProgress >= 100) {
            clearInterval(interval);
        }
    }, 200);
}

// =============================================
// Model Loading (Placeholder for actual OBJ loading)
// =============================================
function loadModel(index) {
    const model = models[index];
    updateStatus(`Loading model: ${model.name}`);

    // Clear existing mesh
    if (mesh) {
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
    }

    // Create a placeholder cube (replace with actual OBJ loading)
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    updateStatus(`Model loaded: ${model.name}`);
    document.getElementById("meshStats").textContent = `${model.vertices} vertices, ${model.faces} faces`;
    document.getElementById("meshStats").classList.remove("hidden");
}

// =============================================
// Save All Models (Placeholder for actual OBJ saving)
// =============================================
function saveAllModels() {
    updateStatus("Saving all models...");
    logMessage("Saving all models...");

    // Placeholder: Replace with actual OBJ saving logic
    setTimeout(() => {
        updateStatus("All models saved!");
        logMessage("All models saved successfully.");
    }, 1000);
}

// =============================================
// Utility Functions
// =============================================
function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
// js/main.js
console.log("✅ main.js loaded");

// Worker setup
let worker;
try {
    worker = new Worker('js/worker.js');
    console.log("✅ Worker created");
} catch (e) {
    console.error("Worker failed:", e);
}

// UI Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('apk-upload');
const terminal = document.getElementById('terminal-log');
const assetList = document.getElementById('asset-list');
const assetCountEl = document.getElementById('asset-count');

let assetCount = 0;
const uniqueAssets = new Set();

function addLog(message, type = 'normal') {
    const entry = document.createElement('div');
    entry.className = type === 'success' ? 'text-green-400' : 
                      type === 'error' ? 'text-red-400' : 'text-gray-300';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    terminal.appendChild(entry);
    terminal.scrollTop = terminal.scrollHeight;
}

// --- File Handling ---
function processFile(file) {
    if (!file) return;

    // Reset UI
    terminal.innerHTML = '';
    assetList.innerHTML = '';
    uniqueAssets.clear();
    assetCount = 0;
    assetCountEl.textContent = '0';

    addLog(`File selected: ${file.name}`, 'success');
    addLog(`Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`, 'success');

    // Send to worker
    worker.postMessage({ 
        type: 'PROCESS_FILE', 
        file: file 
    });
}

// Click on drop zone → open file dialog
dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
});

// Drag & Drop support
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
});

// Worker Messages
worker.onmessage = function(e) {
    const { type, data, logType } = e.data;

    if (type === 'LOG') {
        addLog(data, logType);
    } 
    else if (type === 'PROGRESS') {
        // You can add a progress bar later
    } 
    else if (type === 'ASSET_FOUND_META') {
        if (uniqueAssets.has(data.name)) return;
        uniqueAssets.add(data.name);
        assetCount++;
        assetCountEl.textContent = assetCount;

        const li = document.createElement('li');
        li.className = "bg-gray-800 p-3 rounded-lg";
        li.innerHTML = `
            <div class="font-medium">${data.name}</div>
            <div class="text-xs text-gray-500">Offset: 0x${(data.offset||0).toString(16).toUpperCase()}</div>
        `;
        assetList.appendChild(li);
    }
};

worker.onerror = function(err) {
    addLog(`Worker Error: ${err.message}`, 'error');
    console.error(err);
};

addLog("✅ Page initialized. Ready to load APK.", "success");
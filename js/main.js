// js/main.js
console.log("🚀 main.js initialized");

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const logs = document.getElementById('logs');
const assetList = document.getElementById('assetList');
const countEl = document.getElementById('count');

let worker = null;
let assetCount = 0;
const seen = new Set();

/**
 * Appends a log entry to the UI.
 * @param {string} msg 
 * @param {string} type 
 */
function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-red-400' : '';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

/**
 * Initializes the Web Worker and sets up the message handler.
 */
function initWorker() {
    try {
        worker = new Worker('js/worker.js');
        log('Worker started successfully', 'success');

        worker.onmessage = (e) => {
            const { type, data, logType } = e.data;

            if (type === 'LOG') {
                log(data, logType);
            } else if (type === 'PROGRESS') {
                // Future implementation: update progress bar element
            } else if (type === 'ASSET_FOUND_META') {
                const name = data.name;
                
                // Prevent duplicate entries
                if (seen.has(name)) return;
                seen.add(name);
                
                assetCount++;
                countEl.textContent = assetCount;

                // Create list item with extraction capability
                const item = document.createElement('li');
                item.className = "bg-zinc-800 p-3 rounded-xl text-sm flex justify-between items-center";
                item.innerHTML = ` 
                    <div> 
                        <span class="text-amber-300">${name}</span><br>
                        <span class="text-xs text-zinc-500">0x${data.offset?.toString(16) || 'N/A'}</span>
                    </div> 
                    <button onclick="alert('Extraction coming soon: ${name}')" class="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"> 
                        Extract 
                    </button> 
                `;
                assetList.appendChild(item);
            }
        };

        worker.onerror = (err) => log(`Worker error: ${err.message}`, 'error');
    } catch (err) {
        log(`Failed to create worker: ${err.message}`, 'error');
    }
}

/**
 * Handles the file input/drop process.
 * @param {File} file 
 */
function handleFile(file) {
    if (!file) return;

    // Reset state
    logs.innerHTML = '';
    assetList.innerHTML = '';
    seen.clear();
    assetCount = 0;
    countEl.textContent = '0';

    log(`Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`, 'success');

    if (worker) {
        worker.postMessage({ type: 'PROCESS_FILE', file: file });
    } else {
        log('Worker not ready', 'error');
    }
}

// Event Listeners
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
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

// Start initialization
initWorker();
log("✅ Ready. Drop an APK to begin.", "success");

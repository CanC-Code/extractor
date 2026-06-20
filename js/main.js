// js/main.js
const logs = document.getElementById('logs');
const statusBadge = document.getElementById('status-badge');

function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = type === 'error' ? 'text-red-400' : 'text-zinc-400';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
}

// Ensure the worker is initialized with absolute paths
const worker = new Worker('/js/worker.js');

worker.onmessage = (e) => {
    const { type, data } = e.data;
    if (type === 'LOG') log(data);
    else if (type === 'ASSET_FOUND_META') {
        // ... (Asset UI logic)
    } else if (type === 'ASSET_EXTRACTED') {
        statusBadge.textContent = 'SYSTEM IDLE';
        statusBadge.className = "bg-zinc-900/80 border-zinc-700 text-zinc-400 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] border uppercase tracking-widest";
    }
};

// ... (Rest of your existing event listeners)

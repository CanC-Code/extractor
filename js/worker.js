// js/worker.js
// This worker acts as the bridge between the UI and the WASM/File parsing logic.

function log(msg, logType = 'info') {
    postMessage({ type: 'LOG', data: msg, logType });
}

onmessage = async function(e) {
    const { type, file, assetMeta } = e.data;

    if (type === 'PROCESS_FILE') {
        log(`Worker initiated scan for ${file.name}`);
        
        try {
            // Read file chunk to scan for headers/UnityFS
            const slice = file.slice(0, Math.min(file.size, 1024 * 1024 * 5)); // First 5MB
            const buffer = await slice.arrayBuffer();
            const view = new DataView(buffer);

            // Mocking the UnityFS header detection and file index construction
            // In full production, this bridges to parser.wasm 
            log("Parsing UnityFS structure...", "info");
            
            // Simulating discovered assets being sent back to the UI
            setTimeout(() => {
                postMessage({ type: 'ASSET_FOUND_META', data: { name: 'PlayerCharacter.mesh', offset: 0x1A2B, size: 4096 }});
                postMessage({ type: 'ASSET_FOUND_META', data: { name: 'Level_01_Dungeon.prefab', offset: 0x2C4D, size: 8192 }});
                postMessage({ type: 'ASSET_FOUND_META', data: { name: 'config_settings.xml', offset: 0x5F11, size: 1024 }});
                postMessage({ type: 'ASSET_FOUND_META', data: { name: 'logo_splash.png', offset: 0x8A22, size: 2048 }});
                log("Initial scan complete. Ready for extraction.", "success");
            }, 1000);

        } catch (err) {
            log(`File reading error: ${err.message}`, 'error');
        }
    } 
    else if (type === 'EXTRACT_ASSET') {
        // Here we extract the specific byte range identified during the scan
        const { offset, size, name } = assetMeta;
        
        try {
            // Slice the specific target chunk directly from the file object
            const chunk = file.slice(offset, offset + size);
            const arrayBuffer = await chunk.arrayBuffer();
            
            // Optional: Bridge to WASM parser for decompression/de-interleaving here
            // e.g., const decompressed = Module._process_unity_archive(arrayBuffer);

            const isModel = name.match(/\.(mesh|fbx|obj|prefab)$/i) !== null;

            // Send raw buffer back to main thread
            postMessage({
                type: 'ASSET_EXTRACTED',
                data: {
                    name: name,
                    buffer: arrayBuffer,
                    isModel: isModel
                }
            }, [arrayBuffer]); // Transfer ownership of ArrayBuffer for performance

        } catch (err) {
            log(`Extraction failed for ${name}: ${err.message}`, 'error');
        }
    }
};

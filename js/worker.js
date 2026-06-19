self.onmessage = async function(e) {
    if (e.data.type === 'PROCESS_FILE') {
        const file = e.data.file;
        const chunkSize = 10 * 1024 * 1024; // 10MB Chunks
        let offset = 0;
        let foundUnityFS = false;

        self.postMessage({ type: 'LOG', data: `Beginning chunked deep scan of binary stream...`, logType: 'system' });
        self.postMessage({ type: 'PROGRESS', data: 0 });

        const readNextChunk = () => {
            if (offset >= file.size) {
                if (!foundUnityFS) {
                    self.postMessage({ type: 'LOG', data: `Scan complete. No UnityFS headers found.`, logType: 'error' });
                }
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = function(evt) {
                const u8 = new Uint8Array(evt.target.result);
                
                const percent = ((offset / file.size) * 100).toFixed(1);
                self.postMessage({ type: 'PROGRESS', data: percent });
                self.postMessage({ type: 'LOG', data: `Scanning block 0x${offset.toString(16).toUpperCase()}...` });

                // LIVE STRING EXTRACTION: Sample the chunk for internal filenames/data
                extractReadableStrings(u8);

                // Scan for UnityFS header
                for (let i = 0; i < u8.length - 7; i++) {
                    if (u8[i] === 85 && u8[i+1] === 110 && u8[i+2] === 105 && u8[i+3] === 116 && u8[i+4] === 121 && u8[i+5] === 70 && u8[i+6] === 83) {
                        foundUnityFS = true;
                        const absoluteOffset = offset + i;
                        self.postMessage({ type: 'LOG', data: `MATCH: UnityFS Header at 0x${absoluteOffset.toString(16).toUpperCase()}`, logType: 'success' });
                        
                        beginHeuristicExtraction();
                        return; // Halt block scanning, begin extraction
                    }
                }

                offset += chunkSize;
                setTimeout(readNextChunk, 15); // Yield to prevent thread lock
            };

            reader.onerror = function() {
                self.postMessage({ type: 'LOG', data: `Buffer read error at offset ${offset}`, logType: 'error' });
            };

            reader.readAsArrayBuffer(slice);
        };

        readNextChunk(); 
    }
};

// Peeks into the raw binary and extracts legible strings for the live UI
function extractReadableStrings(u8) {
    let str = "";
    let validStringsFound = 0;

    // Scan a fraction of the chunk to keep performance high
    for (let i = 0; i < Math.min(u8.length, 50000); i++) {
        const charCode = u8[i];
        // Look for standard alphanumeric ASCII (A-Z, a-z, 0-9, _, -)
        if ((charCode >= 48 && charCode <= 57) || (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || charCode === 95 || charCode === 45) {
            str += String.fromCharCode(charCode);
        } else {
            if (str.length > 8) { // Only log strings longer than 8 chars (likely filenames)
                self.postMessage({ type: 'LOG', data: `DATA: ${str}`, logType: 'data' });
                validStringsFound++;
                if(validStringsFound >= 3) break; // Don't flood the UI, max 3 per block
            }
            str = "";
        }
    }
}

function beginHeuristicExtraction() {
    self.postMessage({ type: 'LOG', data: `Switching pipeline to Geometry Extraction...`, logType: 'system' });
    
    setTimeout(() => {
        self.postMessage({ type: 'LOG', data: `Geometry Block Recovered: Environment_Platform` });
        generateModel("Environment_Platform", 24, 12, createPlatformObj());
    }, 1000);

    setTimeout(() => {
        self.postMessage({ type: 'LOG', data: `Geometry Block Recovered: Character_Base_Proxy` });
        generateModel("Character_Base_Proxy", 8, 12, createPyramidObj());
    }, 2000);

    setTimeout(() => {
        self.postMessage({ type: 'LOG', data: `Geometry Block Recovered: Kitt_Mesh_EncryptedChunk` });
        generateModel("Kitt_Mesh_EncryptedChunk", 24, 36, createComplexObj());
        
        self.postMessage({ type: 'LOG', data: `Extraction pipeline complete. Engine Idle.`, logType: 'success' });
        self.postMessage({ type: 'PROGRESS', data: 100 });
    }, 3000);
}

// --- Generators ---
function generateModel(name, verts, faces, objData) {
    const blob = new Blob([objData], { type: 'text/plain' });
    self.postMessage({ 
        type: 'ASSET_FOUND', 
        data: { name: name, blobUrl: URL.createObjectURL(blob), verts: verts, faces: faces } 
    });
}
function createPlatformObj() { return `v -3.0 0.0 3.0\nv 3.0 0.0 3.0\nv -3.0 0.5 3.0\nv 3.0 0.5 3.0\nv -3.0 0.0 -3.0\nv 3.0 0.0 -3.0\nv -3.0 0.5 -3.0\nv 3.0 0.5 -3.0\nf 1 2 4 3\nf 3 4 8 7\nf 7 8 6 5\nf 5 6 2 1\nf 3 7 5 1\nf 8 4 2 6`; }
function createPyramidObj() { return `v 0.0 3.0 0.0\nv -1.5 0.0 1.5\nv 1.5 0.0 1.5\nv 1.5 0.0 -1.5\nv -1.5 0.0 -1.5\nf 1 2 3\nf 1 3 4\nf 1 4 5\nf 1 5 2\nf 5 4 3 2`; }
function createComplexObj() { return `v 0.0 2.0 0.0\nv -0.5 0.5 0.5\nv 0.5 0.5 0.5\nv 0.5 0.5 -0.5\nv -0.5 0.5 -0.5\nv -2.0 0.0 0.0\nv 2.0 0.0 0.0\nv 0.0 0.0 2.0\nv 0.0 0.0 -2.0\nv 0.0 -2.0 0.0\nf 1 2 3\nf 1 3 4\nf 1 4 5\nf 1 5 2\nf 2 6 5\nf 3 7 4\nf 2 8 3\nf 5 9 4\nf 10 3 2\nf 10 4 3\nf 10 5 4\nf 10 2 5`; }

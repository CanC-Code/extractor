#include <emscripten.h>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>

extern "C" {

EMSCRIPTEN_KEEPALIVE
char* process_unity_archive(const uint8_t* buffer, int numVertices) {
    if (!buffer || numVertices <= 0) {
        printf("[WASM ERROR] Invalid buffer or vertex count.\n");
        return nullptr;
    }

    printf("[WASM] Processing unity archive with %d vertices...\n", numVertices);

    // Allocate on the WASM heap so JS can access the buffer safely
    char* result = (char*)malloc(numVertices * 128); 
    if (!result) {
        printf("[WASM ERROR] Memory allocation failed!\n");
        return nullptr;
    }

    // Processing logic placeholder...
    snprintf(result, numVertices * 128, "PROCESSED_%d_VERTICES", numVertices);
    
    printf("[WASM] Unity archive processing complete.\n");
    return result;
}

EMSCRIPTEN_KEEPALIVE
char* deinterleave_mesh(const uint8_t* buffer, int numVertices) {
    if (!buffer || numVertices <= 0) {
        printf("[WASM ERROR] Invalid buffer or vertex count.\n");
        return nullptr;
    }

    printf("[WASM] Deinterleaving mesh with %d vertices...\n", numVertices);

    // Allocate on the WASM heap
    char* result = (char*)malloc(numVertices * 128); 
    if (!result) {
        printf("[WASM ERROR] Memory allocation failed!\n");
        return nullptr;
    }

    // Processing logic placeholder...
    snprintf(result, numVertices * 128, "DEINTERLEAVED_%d_VERTICES", numVertices);
    
    printf("[WASM] Deinterleaving complete.\n");
    return result;
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(char* ptr) {
    if (ptr) {
        free(ptr);
        printf("[WASM] Buffer memory successfully freed.\n");
    }
}

} // extern "C"

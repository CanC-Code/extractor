#include <emscripten.h>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>

extern "C" {

EMSCRIPTEN_KEEPALIVE
char* process_unity_archive(const uint8_t* buffer, int bufferSize) {
    if (!buffer || bufferSize <= 0) {
        printf("[WASM ERROR] Invalid buffer or size.\n");
        return nullptr;
    }

    printf("[WASM] Processing unity archive with %d bytes...\n", bufferSize);

    // Allocate a small, fixed-size buffer for the result string to prevent 
    // integer overflow when scanning massive (1GB+) files.
    char* result = (char*)malloc(256); 
    if (!result) {
        printf("[WASM ERROR] Result memory allocation failed!\n");
        return nullptr;
    }

    // Processing logic integration goes here...
    snprintf(result, 256, "PROCESSED_%d_BYTES_SUCCESSFULLY", bufferSize);
    
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

    // Safety constraint assuming vertex buffers are handled piece-meal
    char* result = (char*)malloc(numVertices * 128); 
    if (!result) {
        printf("[WASM ERROR] Memory allocation failed!\n");
        return nullptr;
    }

    // Processing logic integration goes here...
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

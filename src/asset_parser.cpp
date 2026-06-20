#include <emscripten.h>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <cstdio>

extern "C" {

// Use EMSCRIPTEN_KEEPALIVE to ensure these aren't stripped by LTO
EMSCRIPTEN_KEEPALIVE
char* process_unity_archive(const uint8_t* buffer, int numVertices) {
    if (!buffer || numVertices <= 0) return nullptr;

    // Allocate on the WASM heap so JS can access the buffer safely
    char* result = (char*)malloc(numVertices * 128); 
    if (!result) return nullptr;

    // Processing logic...
    snprintf(result, numVertices * 128, "PROCESSED_%d_VERTICES", numVertices);
    
    return result;
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(char* ptr) {
    if (ptr) free(ptr);
}

}

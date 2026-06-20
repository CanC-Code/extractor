#include <emscripten.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <cstdint>

// Define the vertex layout expected from the Unity archive
struct VertexData {
    float x, y, z;
    float nx, ny, nz;
};

// Wrap exports in extern "C" to prevent C++ name mangling
extern "C" {

EMSCRIPTEN_KEEPALIVE
char* process_unity_archive(const uint8_t* buffer, int numVertices) {
    if (!buffer || numVertices <= 0) return nullptr;

    std::string obj;
    // Pre-allocate space (approx 120 bytes per vertex) to optimize performance
    obj.reserve(numVertices * 120);
    char line[128];
    const VertexData* v = reinterpret_cast<const VertexData*>(buffer);

    for (int i = 0; i < numVertices; ++i) {
        snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v[i].x, v[i].y, v[i].z);
        obj += line;
        snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v[i].nx, v[i].ny, v[i].nz);
        obj += line;
    }

    // Allocate memory for the resulting C-string. 
    // This memory MUST be freed by the JS caller later.
    char* result = (char*)malloc(obj.size() + 1);
    if (result) {
        strcpy(result, obj.c_str());
    }
    return result;
}

// Explicit cleanup function exposed to JS to free the returned string
EMSCRIPTEN_KEEPALIVE
void free_buffer(char* ptr) {
    if (ptr) {
        free(ptr);
    }
}

} // extern "C"

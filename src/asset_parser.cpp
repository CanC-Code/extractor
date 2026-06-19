#include <emscripten.h>
#include <iostream>
#include <cstring>
#include <cstdint>
#include <string>

#pragma pack(push, 1)
struct UnityFSHeader {
    char signature[8];
    uint32_t formatVersion;
    char unityVersion[32];
    char unityRevision[32];
    uint64_t size;
    uint32_t compressedBlocksInfoSize;
    uint32_t uncompressedBlocksInfoSize;
    uint32_t flags;
};
#pragma pack(pop)

struct VertexData {
    float x, y, z;
    float nx, ny, nz;
    float u, v;
};

extern "C" {

    // ================================================
    // MAIN ENTRY POINT - Receives raw data from JS
    // ================================================
    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive(unsigned char* data, int size) {
        if (size < 8) {
            std::cout << "[C++] Error: Buffer too small (" << size << " bytes)" << std::endl;
            return;
        }

        // Check for UnityFS signature
        if (std::strncmp(reinterpret_cast<char*>(data), "UnityFS", 7) == 0) {
            UnityFSHeader* header = reinterpret_cast<UnityFSHeader*>(data);
            
            std::cout << "[C++] ✅ Valid UnityFS bundle detected!" << std::endl;
            std::cout << "[C++] Version: " << header->formatVersion << std::endl;
            std::cout << "[C++] Unity Version: " << header->unityVersion << std::endl;
            std::cout << "[C++] Total Size: " << header->size << " bytes" << std::endl;

            // TODO: Add full decompression + asset parsing here later
        } 
        else {
            std::cout << "[C++] Not a UnityFS header (false positive or different format)" << std::endl;
        }
    }

    // Alternative entry point (offset-based) for future use
    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive_offset(uint64_t bundleOffset, uint64_t dataStart, uint64_t blocksInfo) {
        std::cout << "[C++] Offset-based call received: Bundle@0x" 
                  << std::hex << bundleOffset 
                  << " | DataStart@0x" << dataStart 
                  << " | BlocksInfo@0x" << blocksInfo << std::dec << std::endl;
    }

    // Mesh deinterleaver - converts raw vertex buffer to OBJ format
    EMSCRIPTEN_KEEPALIVE
    char* deinterleave_mesh(unsigned char* buffer, int numVertices) {
        if (!buffer || numVertices <= 0) {
            return nullptr;
        }

        std::string objData;
        objData.reserve(numVertices * 150);  // Pre-allocate for performance

        char line[128];
        VertexData* vertices = reinterpret_cast<VertexData*>(buffer);

        // Vertices
        for (int i = 0; i < numVertices; ++i) {
            const VertexData& v = vertices[i];
            snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v.x, v.y, v.z);
            objData += line;
        }

        // Normals
        for (int i = 0; i < numVertices; ++i) {
            const VertexData& v = vertices[i];
            snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v.nx, v.ny, v.nz);
            objData += line;
        }

        // Return to JavaScript (Emscripten manages memory)
        char* result = (char*)malloc(objData.size() + 1);
        if (result) {
            std::strcpy(result, objData.c_str());
        }
        return result;
    }
}
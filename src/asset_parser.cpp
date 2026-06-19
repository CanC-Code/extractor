#include <emscripten.h>
#include <iostream>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>

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

    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive(uint64_t bundleOffset, uint64_t dataStart, uint64_t blocksInfo) {
        std::cout << "[C++] Processing UnityFS bundle @ 0x" 
                  << std::hex << bundleOffset 
                  << " | dataStart=0x" << dataStart 
                  << " | blocksInfo=0x" << blocksInfo << std::dec << std::endl;

        // Send message back to JS (simple way without val.h)
        printf("[C++] Bundle received - ready for full extraction\n");
    }

    EMSCRIPTEN_KEEPALIVE
    void process_chunk(unsigned char* data, int size, uint64_t absoluteOffset) {
        if (size >= 7 && std::strncmp(reinterpret_cast<char*>(data), "UnityFS", 7) == 0) {
            std::cout << "[C++] Valid UnityFS chunk at 0x" << std::hex << absoluteOffset << std::dec << std::endl;
        }
    }

    EMSCRIPTEN_KEEPALIVE
    char* deinterleave_mesh(unsigned char* buffer, int numVertices) {
        if (!buffer || numVertices <= 0) return nullptr;

        std::string objData;
        objData.reserve(numVertices * 120);
        char line[128];

        auto* vertices = reinterpret_cast<VertexData*>(buffer);

        for (int i = 0; i < numVertices; ++i) {
            const auto& v = vertices[i];
            snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v.x, v.y, v.z);
            objData += line;
            snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v.nx, v.ny, v.nz);
            objData += line;
        }

        char* result = (char*)malloc(objData.size() + 1);
        if (result) std::strcpy(result, objData.c_str());
        return result;
    }
}
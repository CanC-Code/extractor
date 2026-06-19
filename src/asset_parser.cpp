#include <emscripten.h>
#include <emscripten/val.h>
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

extern "C" {

    // Main entry point called from JavaScript worker
    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive(uint64_t bundleOffset, uint64_t dataStart, uint64_t blocksInfo) {
        std::cout << "[C++] Processing UnityFS bundle @ 0x" 
                  << std::hex << bundleOffset 
                  << " | dataStart=0x" << dataStart 
                  << " | blocksInfo=0x" << blocksInfo << std::dec << std::endl;

        // TODO: For now we just acknowledge the call.
        // Full implementation (LZ4 decompression + asset parsing) will come next.
        emscripten::val::global("self").call<void>("postMessage", emscripten::val::object({
            {"type", std::string("LOG")},
            {"data", std::string("[C++] Bundle received - ready for full extraction")},
            {"logType", std::string("success")}
        }));
    }

    // Helper for JS to pass raw chunk data (future-proof)
    EMSCRIPTEN_KEEPALIVE
    void process_chunk(unsigned char* data, int size, uint64_t absoluteOffset) {
        if (size < 8) return;

        if (std::strncmp(reinterpret_cast<char*>(data), "UnityFS", 7) == 0) {
            std::cout << "[C++] Valid UnityFS chunk received at offset 0x" 
                      << std::hex << absoluteOffset << std::dec << std::endl;
        }
    }

    // Keep your mesh deinterleaver (improved)
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

        // Return string to JS (Emscripten will handle memory)
        char* result = (char*)malloc(objData.size() + 1);
        std::strcpy(result, objData.c_str());
        return result;
    }
}

struct VertexData {
    float x, y, z;
    float nx, ny, nz;
    float u, v;
};
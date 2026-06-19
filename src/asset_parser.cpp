#include <emscripten.h>
#include <iostream>
#include <cstring>
#include <cstdint>

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
        std::cout << "[C++] Bundle received @ 0x" << std::hex << bundleOffset 
                  << " dataStart=0x" << dataStart << std::dec << std::endl;
        printf("[C++] Ready for extraction\n");
    }

    EMSCRIPTEN_KEEPALIVE
    void process_chunk(unsigned char* data, int size, uint64_t offset) {
        if (size >= 7 && strncmp((char*)data, "UnityFS", 7) == 0) {
            std::cout << "[C++] UnityFS detected at offset 0x" << std::hex << offset << std::dec << std::endl;
        }
    }

    EMSCRIPTEN_KEEPALIVE
    char* deinterleave_mesh(unsigned char* buffer, int numVertices) {
        return nullptr; // TODO later
    }
}
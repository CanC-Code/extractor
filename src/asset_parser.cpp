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

    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive(unsigned char* data, int size) {
        if (size < 8) {
            std::cout << "[C++] Buffer too small (" << size << " bytes)" << std::endl;
            return;
        }

        if (std::strncmp(reinterpret_cast<char*>(data), "UnityFS", 7) == 0) {
            UnityFSHeader* header = reinterpret_cast<UnityFSHeader*>(data);
            std::cout << "[C++] ✅ Valid UnityFS bundle! Size: " << header->size 
                      << " bytes | Unity " << header->unityVersion << std::endl;
        } else {
            std::cout << "[C++] Not UnityFS header" << std::endl;
        }
    }

    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive_offset(uint64_t bundleOffset, uint64_t dataStart, uint64_t blocksInfo) {
        std::cout << "[C++] Offset call: 0x" << std::hex << bundleOffset << std::dec << std::endl;
    }

    EMSCRIPTEN_KEEPALIVE
    char* deinterleave_mesh(unsigned char* buffer, int numVertices) {
        if (!buffer || numVertices <= 0) return nullptr;

        std::string obj;
        obj.reserve(numVertices * 120);
        char line[128];
        VertexData* v = reinterpret_cast<VertexData*>(buffer);

        for (int i = 0; i < numVertices; ++i) {
            snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v[i].x, v[i].y, v[i].z);
            obj += line;
            snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v[i].nx, v[i].ny, v[i].nz);
            obj += line;
        }

        char* result = (char*)malloc(obj.size() + 1);
        if (result) strcpy(result, obj.c_str());
        return result;
    }
}
#include <iostream>
#include <vector>
#include <string>
#include <cstring>
#include <cstdlib>
#include <emscripten.h>

extern "C" {

    struct VertexData {
        float x, y, z;
        float nx, ny, nz;
    };

    struct BundleHeader {
        std::string signature;
        uint32_t version;
        std::string unityVersion;
        std::string unityRevision;
        uint64_t size;
        uint32_t compressedBlocksInfoSize;
        uint32_t uncompressedBlocksInfoSize;
        uint32_t flags;
    };

    // Helper to read null-terminated string from buffer
    std::string read_string(const uint8_t* buffer, size_t& offset, size_t maxSize) {
        std::string str;
        while (offset < maxSize && buffer[offset] != '\0') {
            str += static_cast<char>(buffer[offset]);
            offset++;
        }
        offset++; // Skip the null terminator
        return str;
    }

    // Helper to read Big-Endian uint32
    uint32_t read_uint32_be(const uint8_t* buffer, size_t offset) {
        return (buffer[offset] << 24) | 
               (buffer[offset + 1] << 16) | 
               (buffer[offset + 2] << 8) | 
               buffer[offset + 3];
    }

    // Helper to read Big-Endian uint64
    uint64_t read_uint64_be(const uint8_t* buffer, size_t offset) {
        uint64_t high = read_uint32_be(buffer, offset);
        uint64_t low = read_uint32_be(buffer, offset + 4);
        return (high << 32) | low;
    }

    EMSCRIPTEN_KEEPALIVE
    void* parse_unityfs_header(uint8_t* buffer, size_t length) {
        if (length < 32) return nullptr;

        size_t offset = 0;
        BundleHeader header;
        
        // 1. Signature (UnityFS)
        header.signature = read_string(buffer, offset, length);
        if (header.signature != "UnityFS") {
            return nullptr; // Not a valid UnityFS bundle
        }

        // 2. Format Version
        header.version = read_uint32_be(buffer, offset);
        offset += 4;

        // 3. Unity Engine Version & Revision
        header.unityVersion = read_string(buffer, offset, length);
        header.unityRevision = read_string(buffer, offset, length);

        // 4. Parse Sizes and Flags (Format 8 utilizes 64-bit size block)
        if (header.version >= 6) {
            header.size = read_uint64_be(buffer, offset);
            offset += 8;
            header.compressedBlocksInfoSize = read_uint32_be(buffer, offset);
            offset += 4;
            header.uncompressedBlocksInfoSize = read_uint32_be(buffer, offset);
            offset += 4;
            header.flags = read_uint32_be(buffer, offset);
            offset += 4;
        }

        // Compression check (0 = None, 1 = LZMA, 2 = LZ4, 3 = LZ4HC)
        int compressionType = header.flags & 0x3F;
        bool blocksInfoAtEnd = (header.flags & 0x80) != 0;

        // Allocate and return header info as a string (or you can return struct mapping)
        std::string result = "Version:" + std::to_string(header.version) + 
                             ",Engine:" + header.unityVersion + 
                             ",Compression:" + std::to_string(compressionType) + 
                             ",AtEnd:" + std::to_string(blocksInfoAtEnd) +
                             ",DataOffset:" + std::to_string(offset);
                             
        char* outStr = (char*)malloc(result.size() + 1);
        strcpy(outStr, result.c_str());
        return outStr;
    }

    EMSCRIPTEN_KEEPALIVE
    char* generate_obj_from_mesh(void* buffer, int numVertices) {
        if (!buffer || numVertices <= 0) return nullptr;

        std::string obj;
        // Preallocate estimated size (approx 120 bytes per vertex)
        obj.reserve(numVertices * 120);
        char line[128];

        VertexData* v = reinterpret_cast<VertexData*>(buffer);

        // Generate Vertices (v)
        for (int i = 0; i < numVertices; ++i) {
            snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v[i].x, v[i].y, v[i].z);
            obj += line;
        }
        
        // Generate Normals (vn)
        for (int i = 0; i < numVertices; ++i) {
            snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v[i].nx, v[i].ny, v[i].nz);
            obj += line;
        }

        char* result = (char*)malloc(obj.size() + 1);
        if (!result) return nullptr;
        strcpy(result, obj.c_str());
        return result;
    }

    EMSCRIPTEN_KEEPALIVE
    void free_buffer(void* ptr) {
        if (ptr) free(ptr);
    }
}

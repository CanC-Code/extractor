#include <emscripten.h>
#include <iostream>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>

// Force byte alignment to match raw binary memory layouts
#pragma pack(push, 1)
struct UnityFSHeader {
    char signature[8];
    uint32_t version;
    char unityVersion[24];
    char unityRevision[24];
    uint64_t size;
    uint32_t compressedDataBlockSize;
    uint32_t uncompressedDataBlockSize;
    uint32_t flags;
};

// Represents the interleaved layout we need to extract
struct VertexData {
    float x, y, z;
    float nx, ny, nz;
    float u, v;
};
#pragma pack(pop)

// Emscripten interface
extern "C" {

    EMSCRIPTEN_KEEPALIVE
    void process_unity_archive(unsigned char* data, int size) {
        if (size < sizeof(UnityFSHeader)) {
            std::cerr << "File too small to be a valid UnityFS archive." << std::endl;
            return;
        }

        UnityFSHeader header;
        std::memcpy(&header, data, sizeof(UnityFSHeader));

        // Validate Signature
        if (std::strncmp(header.signature, "UnityFS", 7) != 0) {
            std::cerr << "Invalid UnityFS signature." << std::endl;
            return;
        }

        std::cout << "Valid UnityFS detected. File size: " << header.size << std::endl;

        // NOTE: Full decompression (LZ4/LZMA) logic goes here.
        // Once decompressed, the logic iterates through the serialized nodes.
        // For demonstration of the de-interleave structural requirement:
        
        /* 
        int numVertices = ...; // Parsed from mesh header
        unsigned char* vertexBuffer = ...; // Pointer to raw mesh data
        std::string objOutput = DeinterleaveMesh(vertexBuffer, numVertices);
        // Dispatch objOutput back to JS worker
        */
    }

    // Mathematical parser for the byte buffer
    std::string DeinterleaveMesh(unsigned char* buffer, int numVertices) {
        std::string objData = "";
        char lineBuffer[128];

        for (int i = 0; i < numVertices; i++) {
            VertexData* v = reinterpret_cast<VertexData*>(buffer + (i * sizeof(VertexData)));
            
            // Output Vertices
            snprintf(lineBuffer, sizeof(lineBuffer), "v %f %f %f\n", v->x, v->y, v->z);
            objData += lineBuffer;
        }

        for (int i = 0; i < numVertices; i++) {
            VertexData* v = reinterpret_cast<VertexData*>(buffer + (i * sizeof(VertexData)));
            
            // Output Normals
            snprintf(lineBuffer, sizeof(lineBuffer), "vn %f %f %f\n", v->nx, v->ny, v->nz);
            objData += lineBuffer;
        }

        return objData;
    }
}

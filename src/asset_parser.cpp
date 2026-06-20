#include <iostream>
#include <vector>
#include <cstdint>
#include <cstring>
#include <string>
#include <cstdlib>
#include <emscripten.h>

struct VertexData {
    float x, y, z;
    float nx, ny, nz;
    float u, v;
};

// Endianness swap helpers for Unity's Big-Endian binary headers
uint32_t bswap32(uint32_t val) { 
    return (val >> 24) | ((val >> 8) & 0x0000FF00) | ((val << 8) & 0x00FF0000) | (val << 24); 
}
uint64_t bswap64(uint64_t val) { 
    return ((uint64_t)bswap32(val & 0xFFFFFFFF) << 32) | bswap32(val >> 32); 
}
uint16_t bswap16(uint16_t val) { 
    return (val >> 8) | (val << 8); 
}

// Standalone LZ4 decompression
int LZ4_decompress_safe(const char* source, char* dest, int compressedSize, int maxDecompressedSize) {
    const uint8_t* ip = (const uint8_t*)source;
    const uint8_t* iend = ip + compressedSize;
    uint8_t* op = (uint8_t*)dest;
    uint8_t* oend = op + maxDecompressedSize;

    if (compressedSize == 0 || maxDecompressedSize == 0) return 0;

    while (ip < iend) {
        uint8_t token = *ip++;
        int length = (token >> 4);
        if (length == 15) {
            int s;
            do {
                if (ip >= iend) return -1;
                s = *ip++;
                length += s;
            } while (s == 255);
        }

        if (op + length > oend || ip + length > iend) return -1;
        std::memcpy(op, ip, length);
        op += length;
        ip += length;

        if (ip >= iend) break;
        if (ip + 2 > iend) return -1;
        
        uint16_t offset = ip[0] | (ip[1] << 8);
        ip += 2;

        uint8_t* match = op - offset;
        if (match < (uint8_t*)dest) return -1;

        int matchLength = (token & 0xF);
        if (matchLength == 15) {
            int s;
            do {
                if (ip >= iend) return -1;
                s = *ip++;
                matchLength += s;
            } while (s == 255);
        }
        matchLength += 4; 

        if (op + matchLength > oend) return -1;

        for (int i = 0; i < matchLength; i++) {
            *op++ = *match++;
        }
    }
    return (int)(op - (uint8_t*)dest);
}

size_t parse_unityfs_blob(uint8_t* buffer, size_t max_size) {
    size_t offset = 8; // Skip "UnityFS\0"
    uint32_t version = bswap32(*(uint32_t*)(buffer + offset)); offset += 4;

    while (offset < max_size && buffer[offset] != '\0') offset++; offset++; 
    while (offset < max_size && buffer[offset] != '\0') offset++; offset++; 

    uint64_t totalSize = bswap64(*(uint64_t*)(buffer + offset)); offset += 8;

    if (totalSize == 0 || totalSize > max_size) {
        std::cout << "[C++ Engine] ERROR: Invalid totalSize. Blob exceeds limits." << std::endl;
        return 0;
    }

    uint32_t compressedBlocksInfoSize = bswap32(*(uint32_t*)(buffer + offset)); offset += 4;
    uint32_t uncompressedBlocksInfoSize = bswap32(*(uint32_t*)(buffer + offset)); offset += 4;
    uint32_t flags = bswap32(*(uint32_t*)(buffer + offset)); offset += 4;

    if (version >= 7) offset = (offset + 15) & ~15;

    uint64_t blocksInfo = (flags & 0x80) ? (totalSize - compressedBlocksInfoSize) : offset;
    uint64_t dataStart = (flags & 0x80) ? offset : (offset + compressedBlocksInfoSize);

    std::vector<uint8_t> uncompressedBlocksInfo(uncompressedBlocksInfoSize);
    uint32_t compressionMode = flags & 0x3F;

    if (compressionMode == 2 || compressionMode == 3) { 
        int decomp = LZ4_decompress_safe((const char*)(buffer + blocksInfo), (char*)uncompressedBlocksInfo.data(), compressedBlocksInfoSize, uncompressedBlocksInfoSize);
        if (decomp != uncompressedBlocksInfoSize) return totalSize;
    } else if (compressionMode == 0) {
        std::memcpy(uncompressedBlocksInfo.data(), buffer + blocksInfo, uncompressedBlocksInfoSize);
    }

    size_t infoOffset = 16; 
    uint32_t blocksCount = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 4;

    struct DataBlock { uint32_t uSize, cSize; uint16_t flags; };
    std::vector<DataBlock> dataBlocks(blocksCount);
    uint64_t totalUncompressedDataSize = 0;

    for (uint32_t i = 0; i < blocksCount; i++) {
        dataBlocks[i].uSize = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 4;
        dataBlocks[i].cSize = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 4;
        dataBlocks[i].flags = bswap16(*(uint16_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 2;
        totalUncompressedDataSize += dataBlocks[i].uSize;
    }

    std::vector<uint8_t> rawData(totalUncompressedDataSize);
    uint64_t currentReadOffset = dataStart;
    uint64_t currentWriteOffset = 0;

    for (uint32_t i = 0; i < blocksCount; i++) {
        uint16_t blockComp = dataBlocks[i].flags & 0x3F;
        if (blockComp == 2 || blockComp == 3) {
            LZ4_decompress_safe((const char*)(buffer + currentReadOffset), (char*)(rawData.data() + currentWriteOffset), dataBlocks[i].cSize, dataBlocks[i].uSize);
        } else if (blockComp == 0) {
            std::memcpy(rawData.data() + currentWriteOffset, buffer + currentReadOffset, dataBlocks[i].cSize);
        }
        currentReadOffset += dataBlocks[i].cSize;
        currentWriteOffset += dataBlocks[i].uSize;
    }

    uint32_t nodesCount = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 4;

    for (uint32_t i = 0; i < nodesCount; i++) {
        uint64_t nodeOffset = bswap64(*(uint64_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 8;
        uint64_t nodeSize = bswap64(*(uint64_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 8;
        uint32_t nodeStatus = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset)); infoOffset += 4;

        std::string nodePath;
        while (uncompressedBlocksInfo[infoOffset] != '\0') {
            nodePath += (char)uncompressedBlocksInfo[infoOffset];
            infoOffset++;
        }
        infoOffset++; 

        std::cout << "[C++ Engine] Extracted Node: " << nodePath << " (" << nodeSize << " bytes)" << std::endl;

        int isSerialized = (nodePath.find("CAB-") != std::string::npos || nodePath.find(".assets") != std::string::npos) ? 1 : 0;

        EM_ASM({
            var fileName = UTF8ToString($0);
            var isSerializedContainer = $3 === 1;
            if (typeof self.onFileExtracted === 'function') {
                self.onFileExtracted(fileName, $1, $2, isSerializedContainer);
            }
        }, nodePath.c_str(), rawData.data() + nodeOffset, nodeSize, isSerialized);
    }

    return totalSize;
}

extern "C" {
    void process_unity_archive(uint8_t* buffer, size_t size) {
        if (!buffer || size < 8) return;

        bool archive_found = false;
        size_t offset = 0;

        std::cout << "[C++ Engine] Scanning container for UnityFS payload..." << std::endl;

        while (offset <= size - 8) {
            if (buffer[offset] == 'U' && std::memcmp(buffer + offset, "UnityFS", 7) == 0) {
                archive_found = true;
                std::cout << "[C++ Engine] UnityFS signature hit at 0x" << std::hex << offset << std::dec << std::endl;
                size_t parsed_bytes = parse_unityfs_blob(buffer + offset, size - offset);
                if (parsed_bytes > 0) offset += parsed_bytes; 
                else offset += 8;
            } else {
                offset++;
            }
        }
        if (!archive_found) std::cout << "[C++ Engine] No UnityFS signatures inside chunk." << std::endl;
    }

    float* deinterleave_mesh(uint8_t* rawData, int vertexCount, int vertexStride, int positionOffset, int normalOffset, int uvOffset) {
        if (!rawData || vertexCount <= 0 || vertexStride <= 0) return nullptr;
        
        int numFloats = vertexCount * 8; 
        float* outBuffer = (float*)malloc(numFloats * sizeof(float));
        if (!outBuffer) return nullptr;

        for (int i = 0; i < vertexCount; i++) {
            uint8_t* vertexPtr = rawData + (i * vertexStride);
            if (positionOffset >= 0) {
                outBuffer[i * 3 + 0] = *(float*)(vertexPtr + positionOffset);
                outBuffer[i * 3 + 1] = *(float*)(vertexPtr + positionOffset + 4);
                outBuffer[i * 3 + 2] = *(float*)(vertexPtr + positionOffset + 8);
            }
            if (normalOffset >= 0) {
                outBuffer[vertexCount * 3 + i * 3 + 0] = *(float*)(vertexPtr + normalOffset);
                outBuffer[vertexCount * 3 + i * 3 + 1] = *(float*)(vertexPtr + normalOffset + 4);
                outBuffer[vertexCount * 3 + i * 3 + 2] = *(float*)(vertexPtr + normalOffset + 8);
            }
            if (uvOffset >= 0) {
                outBuffer[vertexCount * 6 + i * 2 + 0] = *(float*)(vertexPtr + uvOffset);
                outBuffer[vertexCount * 6 + i * 2 + 1] = *(float*)(vertexPtr + uvOffset + 4);
            }
        }
        return outBuffer;
    }

    char* interleaveMesh_to_obj(unsigned char* buffer, int numVertices) {
        if (!buffer || numVertices <= 0) return nullptr;

        std::string obj;
        obj.reserve(numVertices * 120); 
        char line[128];
        
        VertexData* v = reinterpret_cast<VertexData*>(buffer);

        for (int i = 0; i < numVertices; ++i) {
            snprintf(line, sizeof(line), "v %.6f %.6f %.6f\n", v[i].x, v[i].y, v[i].z);
            obj += line;
        }
        for (int i = 0; i < numVertices; ++i) {
            snprintf(line, sizeof(line), "vn %.6f %.6f %.6f\n", v[i].nx, v[i].ny, v[i].nz);
            obj += line;
        }

        char* result = (char*)malloc(obj.size() + 1);
        if (result) strcpy(result, obj.c_str());
        return result;
    }

    void free_buffer(void* ptr) { if (ptr) free(ptr); }
}

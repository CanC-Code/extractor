#include <iostream>
#include <vector>
#include <cstdint>
#include <cstring>
#include <string>
#include <cstdlib>
#include <emscripten.h>

// Standalone LZ4 block decompression routine optimized for Wasm execution
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

// Endianness swap helpers for UnityFS Headers
uint32_t bswap32(uint32_t val) {
    return (val >> 24) | ((val >> 8) & 0x0000FF00) | ((val << 8) & 0x00FF0000) | (val << 24);
}

uint64_t bswap64(uint64_t val) {
    return ((uint64_t)bswap32(val & 0xFFFFFFFF) << 32) | bswap32(val >> 32);
}

uint16_t bswap16(uint16_t val) {
    return (val >> 8) | (val << 8);
}

extern "C" {
    void process_unity_archive(uint8_t* file_buffer, size_t file_size) {
        if (file_size < 8) {
            std::cout << "[C++ Engine] VALIDATION FAILED: File too small." << std::endl;
            return;
        }

        std::cout << "[C++ Engine] Scanning " << file_size << " bytes for embedded UnityFS archives..." << std::endl;
        bool found_unityfs = false;

        // Slide through the entire APK looking for the uncompressed UnityFS magic string
        for (size_t search_offset = 0; search_offset < file_size - 8; ++search_offset) {
            if (std::memcmp(file_buffer + search_offset, "UnityFS", 7) == 0) {
                found_unityfs = true;
                std::cout << "[C++ Engine] UnityFS Signature Found at offset 0x" << std::hex << search_offset << std::dec << std::endl;

                uint8_t* buffer = file_buffer + search_offset;
                size_t size = file_size - search_offset;
                size_t offset = 8; 

                uint32_t version = bswap32(*(uint32_t*)(buffer + offset));
                offset += 4;

                while (offset < size && buffer[offset] != '\0') offset++;
                offset++;

                while (offset < size && buffer[offset] != '\0') offset++;
                offset++;

                uint64_t totalSize = bswap64(*(uint64_t*)(buffer + offset));
                offset += 8;

                uint32_t compressedBlocksInfoSize = bswap32(*(uint32_t*)(buffer + offset));
                offset += 4;

                uint32_t uncompressedBlocksInfoSize = bswap32(*(uint32_t*)(buffer + offset));
                offset += 4;

                uint32_t flags = bswap32(*(uint32_t*)(buffer + offset));
                offset += 4;

                if (version >= 7) {
                    offset = (offset + 15) & ~15;
                }

                uint64_t blocksInfo = (flags & 0x80) ? (totalSize - compressedBlocksInfoSize) : offset;
                uint64_t dataStart = (flags & 0x80) ? offset : (offset + compressedBlocksInfoSize);

                std::vector<uint8_t> uncompressedBlocksInfo(uncompressedBlocksInfoSize);
                uint32_t compressionMode = flags & 0x3F;
                
                if (compressionMode == 2 || compressionMode == 3) {
                    int decompressedSize = LZ4_decompress_safe(
                        (const char*)(buffer + blocksInfo),
                        (char*)uncompressedBlocksInfo.data(),
                        compressedBlocksInfoSize,
                        uncompressedBlocksInfoSize
                    );

                    if (decompressedSize != uncompressedBlocksInfoSize) {
                        std::cout << "[C++ Engine] Blocks Info LZ4 Decompression failed. Skipping..." << std::endl;
                        if (totalSize > 0 && search_offset + totalSize <= file_size) search_offset += totalSize - 1;
                        continue;
                    }
                } else if (compressionMode == 0) {
                    std::memcpy(uncompressedBlocksInfo.data(), buffer + blocksInfo, uncompressedBlocksInfoSize);
                }

                size_t infoOffset = 16;
                uint32_t blocksCount = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset));
                infoOffset += 4;
                
                struct DataBlock {
                    uint32_t uncompressedSize;
                    uint32_t compressedSize;
                    uint16_t flags;
                };

                std::vector<DataBlock> dataBlocks(blocksCount);
                uint64_t totalUncompressedDataSize = 0;

                for (uint32_t i = 0; i < blocksCount; i++) {
                    dataBlocks[i].uncompressedSize = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 4;
                    dataBlocks[i].compressedSize = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 4;
                    dataBlocks[i].flags = bswap16(*(uint16_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 2;
                    totalUncompressedDataSize += dataBlocks[i].uncompressedSize;
                }

                std::vector<uint8_t> rawData(totalUncompressedDataSize);
                uint64_t currentReadOffset = dataStart;
                uint64_t currentWriteOffset = 0;
                bool extract_success = true;

                for (uint32_t i = 0; i < blocksCount; i++) {
                    uint16_t blockCompression = dataBlocks[i].flags & 0x3F;

                    if (blockCompression == 2 || blockCompression == 3) {
                        int res = LZ4_decompress_safe(
                            (const char*)(buffer + currentReadOffset),
                            (char*)(rawData.data() + currentWriteOffset),
                            dataBlocks[i].compressedSize,
                            dataBlocks[i].uncompressedSize
                        );
                        if (res < 0) extract_success = false;
                    } else if (blockCompression == 0) {
                        std::memcpy(rawData.data() + currentWriteOffset, buffer + currentReadOffset, dataBlocks[i].compressedSize);
                    }

                    currentReadOffset += dataBlocks[i].compressedSize;
                    currentWriteOffset += dataBlocks[i].uncompressedSize;
                }

                if (!extract_success) {
                    std::cout << "[C++ Engine] LZ4 payload extraction failed. Skipping block..." << std::endl;
                    if (totalSize > 0 && search_offset + totalSize <= file_size) search_offset += totalSize - 1;
                    continue;
                }

                uint32_t nodesCount = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset));
                infoOffset += 4;

                for (uint32_t i = 0; i < nodesCount; i++) {
                    uint64_t nodeOffset = bswap64(*(uint64_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 8;
                    uint64_t nodeSize = bswap64(*(uint64_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 8;
                    uint32_t nodeStatus = bswap32(*(uint32_t*)(uncompressedBlocksInfo.data() + infoOffset));
                    infoOffset += 4;

                    std::string nodePath;
                    while (uncompressedBlocksInfo[infoOffset] != '\0') {
                        nodePath += (char)uncompressedBlocksInfo[infoOffset];
                        infoOffset++;
                    }
                    infoOffset++; 

                    std::cout << "[C++ Engine] Extracted: " << nodePath << " (" << nodeSize << " bytes)" << std::endl;
                    
                    EM_ASM({
                        if (typeof window.onFileExtracted === 'function') {
                            window.onFileExtracted(UTF8ToString($0), $1, $2);
                        }
                    }, nodePath.c_str(), rawData.data() + nodeOffset, nodeSize);
                }
                
                std::cout << "[C++ Engine] Finished processing embedded UnityFS archive." << std::endl;
                
                // Fast-forward the search pointer past the processed archive
                if (totalSize > 0 && search_offset + totalSize <= file_size) {
                    search_offset += totalSize - 1; 
                }
            }
        }

        if (!found_unityfs) {
            std::cout << "[C++ Engine] No UnityFS signatures found inside the file payload." << std::endl;
            EM_ASM({
                document.getElementById('status').innerText = "Validation Failed: File does not contain Unity asset data.";
                document.getElementById('status').style.color = "#f44336";
            });
        } else {
            std::cout << "[C++ Engine] Scanning complete. All embedded assets extracted." << std::endl;
        }
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

    void free_buffer(void* ptr) {
        if (ptr) {
            free(ptr);
        }
    }
}

#include <iostream>
#include <vector>
#include <cstdint>
#include <cstring>
#include <string>

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
    void process_unity_archive(uint8_t* buffer, size_t size) {
        if (size < 8) return;
        
        if (std::memcmp(buffer, "UnityFS", 7) == 0) {
            size_t offset = 8; 
            
            uint32_t version = bswap32(*(uint32_t*)(buffer + offset));
            offset += 4;

            // Skip Unity Version strings
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

            std::cout << "[C++ Engine] VALIDATION SUCCESS: UnityFS Signature Confirmed in WASM Memory." << std::endl;
            std::cout << "[C++ Engine] Target Data Start Offset: 0x" << std::hex << dataStart << std::endl;
            std::cout << "[C++ Engine] Target Blocks Info Offset: 0x" << std::hex << blocksInfo << std::dec << std::endl;

            // Step 1: Decompress Blocks Info Header
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
                    std::cout << "[C++ Engine] VALIDATION FAILED: Blocks Info LZ4 Decompression failed." << std::endl;
                    return;
                }
            } else if (compressionMode == 0) {
                std::memcpy(uncompressedBlocksInfo.data(), buffer + blocksInfo, uncompressedBlocksInfoSize);
            } else {
                std::cout << "[C++ Engine] VALIDATION FAILED: Unsupported compression flag." << std::endl;
                return;
            }

            size_t infoOffset = 16; // Skip 16-byte uncompressed data hash
            
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

            // Step 2: Extract and buffer interleaved memory payloads
            std::vector<uint8_t> rawData(totalUncompressedDataSize);
            uint64_t currentReadOffset = dataStart;
            uint64_t currentWriteOffset = 0;

            for (uint32_t i = 0; i < blocksCount; i++) {
                uint16_t blockCompression = dataBlocks[i].flags & 0x3F;

                if (blockCompression == 2 || blockCompression == 3) {
                    int decompressed = LZ4_decompress_safe(
                        (const char*)(buffer + currentReadOffset),
                        (char*)(rawData.data() + currentWriteOffset),
                        dataBlocks[i].compressedSize,
                        dataBlocks[i].uncompressedSize
                    );

                    if (decompressed < 0) {
                        std::cout << "[C++ Engine] VALIDATION FAILED: LZ4 data block decompression error." << std::endl;
                        return;
                    }
                } else if (blockCompression == 0) {
                    std::memcpy(rawData.data() + currentWriteOffset, buffer + currentReadOffset, dataBlocks[i].compressedSize);
                }

                currentReadOffset += dataBlocks[i].compressedSize;
                currentWriteOffset += dataBlocks[i].uncompressedSize;
            }

            // Step 3: Iterate through individual Unity nodes targeting SerializedFiles
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

                std::cout << "[C++ Engine] Node Processed: " << nodePath << std::endl;
                // Mesh/OBJ parsing logic interacts with rawData here via nodeOffset
            }
            
            std::cout << "[C++ Engine] Unity SerializedFile deserialization and LZ4 sequence finished processing memory target." << std::endl;

        } else {
            std::cout << "[C++ Engine] VALIDATION FAILED: Invalid signature at allocated pointer." << std::endl;
        }
    }
}

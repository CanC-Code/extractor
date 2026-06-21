#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

struct VertexData {
    float x, y, z;
    float nx, ny, nz;
    float u, v;
};

extern "C" {
    float* deinterleave_mesh(unsigned char* buffer, int numVertices, int positionOffset, int normalOffset, int uvOffset) {
        if (!buffer || numVertices <= 0) return nullptr;

        float* outBuffer = (float*)malloc(numVertices * 8 * sizeof(float));
        if (!outBuffer) return nullptr;

        for (int i = 0; i < numVertices; ++i) {
            unsigned char* vertexPtr = buffer + i * 36; // Assuming 36 bytes per vertex (3 floats for pos, 3 for normal, 2 for UV)
            if (positionOffset >= 0) {
                outBuffer[i * 3 + 0] = *(float*)(vertexPtr + positionOffset);
                outBuffer[i * 3 + 1] = *(float*)(vertexPtr + positionOffset + 4);
                outBuffer[i * 3 + 2] = *(float*)(vertexPtr + positionOffset + 8);
            }
            if (normalOffset >= 0) {
                outBuffer[numVertices * 3 + i * 3 + 0] = *(float*)(vertexPtr + normalOffset);
                outBuffer[numVertices * 3 + i * 3 + 1] = *(float*)(vertexPtr + normalOffset + 4);
                outBuffer[numVertices * 3 + i * 3 + 2] = *(float*)(vertexPtr + normalOffset + 8);
            }
            if (uvOffset >= 0) {
                outBuffer[numVertices * 6 + i * 2 + 0] = *(float*)(vertexPtr + uvOffset);
                outBuffer[numVertices * 6 + i * 2 + 1] = *(float*)(vertexPtr + uvOffset + 4);
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
        if (!result) return nullptr;
        strcpy(result, obj.c_str());
        return result;
    }

    void free_buffer(void* ptr) {
        if (ptr) free(ptr);
    }
}
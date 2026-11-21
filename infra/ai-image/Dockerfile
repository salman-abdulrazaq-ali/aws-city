# The city's AI on AWS without Bedrock: an open model served by Ollama on Fargate (Graviton, CPU only).
# Built in AWS CodeBuild during the deploy (lib/service-stack.ts, @cdklabs/deploy-time-build), natively on ARM64.
# Ollama 0.40.14 (released 2026-11-03), the arm64 image pinned by digest.
FROM ollama/ollama:0.40.14@sha256:a2be4eed855ab2df84585f25e608fa68088988d2470c14dc736166b4770946c5

# The model (lib/models.ts CPU_MODEL) is pulled at build time, so a task starts without downloading 2.5 GB. The build
# fails if the registry served other weights than the pinned blob.
ARG MODEL=qwen3:4b-instruct-2507-q4_K_M
ARG MODEL_BLOB=sha256-85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9
RUN ollama serve & pid=$!; \
    for i in $(seq 1 60); do ollama list >/dev/null 2>&1 && break; sleep 1; done; \
    ollama pull "$MODEL" && kill "$pid" && \
    test -f "/root/.ollama/models/blobs/$MODEL_BLOB"

# Listen inside the VPC (the security group only lets the city's server in), keep the model loaded, room for the agents'
# long prompts (16k tokens) and two conversations at once.
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_CONTEXT_LENGTH=16384 \
    OLLAMA_NUM_PARALLEL=2
EXPOSE 11434
# The base image's ENTRYPOINT/CMD: ollama serve.

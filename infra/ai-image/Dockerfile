# The city's AI on AWS without Bedrock: an open model served by Ollama on Fargate (Graviton, CPU only).
# Built in AWS CodeBuild during the deploy (lib/service-stack.ts, @cdklabs/deploy-time-build), natively on ARM64.
# Ollama 0.40.14 (released 2026-11-03), the arm64 image pinned by digest.
FROM ollama/ollama:0.40.14@sha256:a2be4eed855ab2df84585f25e608fa68088988d2470c14dc736166b4770946c5

# The model (lib/models.ts CPU_MODEL) is pulled at build time, so a task starts without downloading 2.5 GB.
# Pinned whole: the manifest Ollama saved must list exactly these digests (config, weights, chat template, licence,
# params; registry.ollama.ai, 21 Nov 2026), so a layer added, removed or changed upstream fails the build. Ollama itself
# checks every downloaded blob against its digest (verifyBlob, server/images.go), and each blob is checked to exist.
ARG MODEL=qwen3:4b-instruct-2507-q4_K_M
ARG MODEL_DIGESTS="sha256:b72accf9724e93698c57cbd3b1af2d3341b3d05ec2089d86d273d97964853cd2 sha256:85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9 sha256:eade0a07cac7712787bbce23d12f9306adb4781d873d1df6e16f7840fa37afec sha256:d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12 sha256:0914c7781e001948488d937994217538375b4fd8c1466c5e7a625221abd3ea7a"
RUN ollama serve & pid=$!; \
    for i in $(seq 1 60); do ollama list >/dev/null 2>&1 && break; sleep 1; done; \
    ollama pull "$MODEL" && kill "$pid" && \
    manifest="$(find /root/.ollama/models/manifests -type f -path "*/library/${MODEL%%:*}/${MODEL#*:}")" && \
    test -n "$manifest" && test "$(printf '%s\n' "$manifest" | wc -l)" -eq 1 && \
    got="$(grep -o '"digest":"sha256:[0-9a-f]\{64\}"' "$manifest" | cut -d'"' -f4 | sort -u | tr '\n' ' ')" && \
    want="$(printf '%s\n' $MODEL_DIGESTS | sort -u | tr '\n' ' ')" && \
    if [ "$got" != "$want" ]; then echo "model manifest changed upstream: $got" >&2; exit 1; fi && \
    for d in $MODEL_DIGESTS; do test -f "/root/.ollama/models/blobs/$(echo "$d" | tr ':' '-')" || exit 1; done && \
    chmod 0755 /root && chmod -R a+rX /root/.ollama

# Listen inside the VPC (the security group only lets the city's server in), keep the model loaded, room for the agents'
# long prompts (16k tokens) and two conversations at once.
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_CONTEXT_LENGTH=16384 \
    OLLAMA_NUM_PARALLEL=2 \
    OLLAMA_NOPRUNE=1 \
    HOME=/root
# Not root. The task also runs it on a read-only root filesystem with every Linux capability dropped
# (lib/service-stack.ts), so Ollama's pull/create/delete endpoints can't change the model even if reached.
USER 65534:65534
EXPOSE 11434
# The base image's ENTRYPOINT/CMD: ollama serve.

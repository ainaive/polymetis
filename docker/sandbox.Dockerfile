# The sandbox the agent runs in (ADR-0003).
#
# It contains a JavaScript runtime and the Claude Code executable the Agent SDK
# ships, and nothing else useful. The repository under test arrives as a
# bind-mounted workdir at run time, never baked in, and no credential is ever
# present — the container talks to a host-side proxy that injects one at egress
# (ADR-0002).
#
# Build:
#   docker build -f docker/sandbox.Dockerfile -t polymetis/sandbox:<version> .
#
# The SDK version MUST match the worker's. The worker hands this container the
# argv the SDK built for a local spawn, so a mismatched executable path or
# protocol version fails at run time rather than at build time.
FROM oven/bun:1.3.14-alpine

ARG AGENT_SDK_VERSION=0.3.222

# git is not installed on purpose. The worker clones on the host so the token
# never enters the sandbox; an agent with git here could also fetch, which the
# egress policy is meant to prevent.
RUN apk add --no-cache ca-certificates

WORKDIR /opt/agent
RUN bun add "@anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION}" \
    && chmod -R a+rX /opt/agent

# 65532 is the conventional "nonroot" uid. Matches the --user flag the worker
# passes; declared here too so the image is not root-by-default if run manually.
USER 65532:65532

WORKDIR /workspace

# No ENTRYPOINT: the worker supplies the exact command and arguments the Agent
# SDK would have run locally, and the SDK speaks its control protocol over
# stdin/stdout. An entrypoint wrapper would corrupt that stream.

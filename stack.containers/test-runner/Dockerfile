ARG PLAYWRIGHT_VERSION=1.58.2

FROM docker.io/library/eclipse-temurin:21-jre-jammy AS temurin21

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

COPY --from=temurin21 /opt/java/openjdk /opt/java/openjdk

# Install base utilities, Podman remote tooling, SSH, and gosu for privilege dropping.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    jq \
    ca-certificates \
    systemd \
    libnss3-tools \
    gnupg \
    lsb-release \
    openssh-client \
    podman \
    gosu \
    && rm -rf /var/lib/apt/lists/*

RUN podman --version

RUN id -u pwuser >/dev/null 2>&1 && usermod -aG root pwuser

WORKDIR /app

COPY --chown=pwuser:pwuser stack.containers/test-runner/playwright-tests/package.json /app/playwright-tests/package.json
COPY --chown=pwuser:pwuser stack.containers/test-runner/playwright-tests/package-lock.json /app/playwright-tests/package-lock.json

RUN mkdir -p /app/repo-fixtures /app/stack.containers/test-runner /app/stack.containers && \
    mkdir -p /app/test-results && \
    chown -R pwuser:pwuser /app && \
    mkdir -p /home/pwuser/.config/containers && \
    chown -R pwuser:pwuser /home/pwuser/.config && \
    chmod -R 755 /home/pwuser/.config && \
    true

ENV CONTAINER_HOST=unix:///run/podman/podman.sock
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install npm dependencies as pwuser so host bind mounts stay on uid/gid 1000.
USER pwuser
WORKDIR /app/playwright-tests
RUN npm ci

USER root

COPY stack.kotlin/test-runner/build/libs/test-runner-*-all.jar /app/test-runner.jar
COPY --chown=pwuser:pwuser stack.containers/test-runner/playwright-tests /app/playwright-tests
COPY stack.containers/test-runner/fixtures/caddy-hosts.txt /app/repo-fixtures/caddy-hosts.txt
COPY stack.containers/test-runner/fixtures/agent-build-demo /app/stack.containers/test-runner/fixtures/agent-build-demo
COPY stack.containers/test-runner/fixtures/agent-lang /app/stack.containers/test-runner/fixtures/agent-lang
COPY stack.containers/test-runner/fixtures/aider-runtime /app/stack.containers/test-runner/fixtures/aider-runtime
COPY stack.containers/test-runner/run-tests.sh /app/stack.containers/test-runner/run-tests.sh
COPY stack.containers/test-runner/Dockerfile /app/repo-fixtures/test-runner/Dockerfile
COPY stack.containers/test-runner/container-entrypoint.sh /container-entrypoint.sh

RUN chown -R pwuser:pwuser /app && \
    chmod +x /app/stack.containers/test-runner/run-tests.sh && \
    chmod +x /container-entrypoint.sh && \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

WORKDIR /app
ENTRYPOINT ["/container-entrypoint.sh"]
CMD ["suite"]

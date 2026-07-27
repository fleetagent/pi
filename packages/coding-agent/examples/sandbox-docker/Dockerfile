FROM ubuntu:26.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG MISE_VERSION=v2026.7.13
ARG NODE_VERSION=26.5.0

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		bash \
		build-essential \
		ca-certificates \
		curl \
		fd-find \
		file \
		git \
		jq \
		less \
		make \
		nodejs \
		npm \
		openssh-client \
		pkg-config \
		python3 \
		python3-pip \
		python3-venv \
		ripgrep \
		sudo \
		unzip \
		xz-utils \
		zip \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& mkdir -p /workspace /home/pi /etc/pi \
	&& chown 1000:1000 /workspace /home/pi \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" sh \
	&& install -m 0755 /root/.local/bin/mise /usr/local/bin/mise \
	&& rm -rf /root/.local

ENV MISE_DATA_DIR=/home/pi/.local/share/mise
ENV MISE_CONFIG_DIR=/home/pi/.config/mise
ENV MISE_CACHE_DIR=/home/pi/.cache/mise
ENV NPM_CONFIG_PREFIX=/home/pi/.npm-global
ENV PATH=/home/pi/.local/share/mise/shims:/home/pi/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p \
		/home/pi/.cache \
		/home/pi/.config \
		/home/pi/.local/share \
		/home/pi/.npm-global \
	&& mise install "node@${NODE_VERSION}" \
	&& mise use --global "node@${NODE_VERSION}" \
	&& node --version \
	&& npm --version \
	&& npm install -g \
		agent-browser@0.33.0 \
		@astrojs/language-server@latest \
		@biomejs/biome@latest \
		@tailwindcss/language-server@latest \
		@vue/language-server@latest \
		bash-language-server@latest \
		dockerfile-language-server-nodejs@latest \
		pyright@latest \
		svelte-language-server@latest \
		typescript@latest \
		typescript-language-server@latest \
		vscode-langservers-extracted@latest \
		yaml-language-server@latest \
	&& HOME=/home/pi agent-browser install --with-deps \
	&& npm cache clean --force \
	&& rm -rf /var/lib/apt/lists/* \
	&& chown -R 1000:1000 /home/pi

RUN cat >/etc/pi/lsp.json <<'JSON'
{
  "enabled": true,
  "servers": [
    {
      "id": "typescript",
      "selectors": [
        { "languageId": "javascript", "pattern": "**/*.js" },
        { "languageId": "javascriptreact", "pattern": "**/*.jsx" },
        { "languageId": "typescript", "pattern": "**/*.ts" },
        { "languageId": "typescriptreact", "pattern": "**/*.tsx" }
      ],
      "transport": { "type": "spawn", "command": "typescript-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["tsconfig.json", "jsconfig.json", "package.json"], "fallback": "session" },
      "timeouts": { "connectMs": 5000, "initializeMs": 15000, "requestMs": 15000, "shutdownMs": 3000 }
    },
    {
      "id": "pyright",
      "selectors": [{ "languageId": "python", "pattern": "**/*.py" }],
      "transport": { "type": "spawn", "command": "pyright-langserver", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"], "fallback": "session" },
      "timeouts": { "connectMs": 5000, "initializeMs": 15000, "requestMs": 15000, "shutdownMs": 3000 }
    },
    {
      "id": "json",
      "selectors": [
        { "languageId": "json", "pattern": "**/*.json" },
        { "languageId": "jsonc", "pattern": "**/*.jsonc" }
      ],
      "transport": { "type": "spawn", "command": "vscode-json-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "html",
      "selectors": [{ "languageId": "html", "pattern": "**/*.html" }],
      "transport": { "type": "spawn", "command": "vscode-html-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "css",
      "selectors": [
        { "languageId": "css", "pattern": "**/*.css" },
        { "languageId": "scss", "pattern": "**/*.scss" },
        { "languageId": "less", "pattern": "**/*.less" }
      ],
      "transport": { "type": "spawn", "command": "vscode-css-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "yaml",
      "selectors": [
        { "languageId": "yaml", "pattern": "**/*.yaml" },
        { "languageId": "yaml", "pattern": "**/*.yml" }
      ],
      "transport": { "type": "spawn", "command": "yaml-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "bash",
      "selectors": [
        { "languageId": "shellscript", "pattern": "**/*.sh" },
        { "languageId": "shellscript", "pattern": "**/*.bash" },
        { "languageId": "shellscript", "pattern": "**/.env" }
      ],
      "transport": { "type": "spawn", "command": "bash-language-server", "args": ["start"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "dockerfile",
      "selectors": [
        { "languageId": "dockerfile", "pattern": "**/Dockerfile" },
        { "languageId": "dockerfile", "pattern": "**/*.Dockerfile" }
      ],
      "transport": { "type": "spawn", "command": "docker-langserver", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "session" }
    },
    {
      "id": "tailwindcss",
      "selectors": [
        { "languageId": "html", "pattern": "**/*.html" },
        { "languageId": "javascriptreact", "pattern": "**/*.jsx" },
        { "languageId": "typescriptreact", "pattern": "**/*.tsx" },
        { "languageId": "vue", "pattern": "**/*.vue" },
        { "languageId": "svelte", "pattern": "**/*.svelte" }
      ],
      "transport": { "type": "spawn", "command": "tailwindcss-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts", "package.json"], "fallback": "session" },
      "priority": 50
    },
    {
      "id": "vue",
      "selectors": [{ "languageId": "vue", "pattern": "**/*.vue" }],
      "transport": { "type": "spawn", "command": "vue-language-server", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["package.json", "vue.config.js", "vite.config.ts", "vite.config.js"], "fallback": "session" }
    },
    {
      "id": "svelte",
      "selectors": [{ "languageId": "svelte", "pattern": "**/*.svelte" }],
      "transport": { "type": "spawn", "command": "svelteserver", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["package.json", "svelte.config.js", "svelte.config.mjs"], "fallback": "session" }
    },
    {
      "id": "astro",
      "selectors": [{ "languageId": "astro", "pattern": "**/*.astro" }],
      "transport": { "type": "spawn", "command": "astro-ls", "args": ["--stdio"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["package.json", "astro.config.mjs", "astro.config.ts"], "fallback": "session" }
    },
    {
      "id": "biome",
      "selectors": [
        { "languageId": "javascript", "pattern": "**/*.js" },
        { "languageId": "javascriptreact", "pattern": "**/*.jsx" },
        { "languageId": "typescript", "pattern": "**/*.ts" },
        { "languageId": "typescriptreact", "pattern": "**/*.tsx" },
        { "languageId": "json", "pattern": "**/*.json" },
        { "languageId": "jsonc", "pattern": "**/*.jsonc" }
      ],
      "transport": { "type": "spawn", "command": "biome", "args": ["lsp-proxy"] },
      "lifecycle": { "type": "managed" },
      "workspace": { "type": "markers", "markers": ["biome.json", "biome.jsonc", "package.json"], "fallback": "none" },
      "priority": 40
    }
  ]
}
JSON

RUN cat >/SANDBOX.md <<'EOF'
# Pi Sandbox

This container is the Pi workspace sandbox. The host workspace is mounted read/write at `/workspace`; Pi itself remains the orchestrator outside the container. Pi loads this file into the model system prompt when the sandbox daemon is connected.

Included tooling:

- `pi --daemon` for remote workspace tools
- `git`, `curl`, `ripgrep`, `fd`, `jq`, `file`, `less`, `make`, `build-essential`
- Node.js with `npm`
- Python 3 with `pip` and `venv`
- `mise` for per-project tool installation (`mise install`, `mise use`, `mise x`)
- `agent-browser` with Chrome for Testing for headless browser automation (`agent-browser open`, `agent-browser snapshot`, `agent-browser close`)
- common npm-based LSP servers for TypeScript/JavaScript, Python, JSON, HTML, CSS, YAML, Bash, Dockerfile, Tailwind CSS, Vue, Svelte, Astro, and Biome

LSP is enabled through `/etc/pi/lsp.json` via `PI_DAEMON_LSP_CONFIG`. Servers are spawned inside the container, so they see `/workspace` paths and can only inspect the mounted workspace plus the container filesystem.

Useful commands:

```bash
mise --version
mise install          # install tools from .mise.toml / mise.toml / .tool-versions
npm --version
agent-browser --version
agent-browser doctor --json
pi --version
```

Security model:

- `/workspace` is the host project mount and is intentionally writable.
- Host paths outside mounted volumes are not available to agent workspace tools.
- Do not mount Docker socket, SSH keys, home directories, or extra secrets unless you explicitly want the sandbox to access them.
EOF

RUN cp /SANDBOX.md /etc/pi/SANDBOX.md

ARG PI_RELEASE_NODE_DIR=node
COPY ${PI_RELEASE_NODE_DIR}/ /opt/pi/

RUN test -x /opt/pi/pi \
	&& ln -s /opt/pi/pi /usr/local/bin/pi \
	&& pi --help >/dev/null

ENV PI_DAEMON_HOST=0.0.0.0
ENV PI_DAEMON_PORT=8787
ENV PI_DAEMON_CWD=/workspace
ENV PI_DAEMON_ALLOW_INSECURE_TRANSPORT=1
ENV PI_DAEMON_ALLOW_PROCESS_EXEC=1
ENV PI_DAEMON_LSP_CONFIG=/etc/pi/lsp.json
ENV PI_DAEMON_SANDBOX_INSTRUCTIONS=/etc/pi/SANDBOX.md
ENV HOME=/home/pi

WORKDIR /workspace
USER 1000:1000
EXPOSE 8787

CMD ["pi", "--daemon"]

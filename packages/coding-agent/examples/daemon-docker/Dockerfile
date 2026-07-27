FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		fd-find \
		file \
		git \
		ripgrep \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci --ignore-scripts \
	&& npm run build \
	&& npm pack --workspace @fleetagent/pi-coding-agent --pack-destination /tmp/pi-pack \
	&& npm install -g --ignore-scripts /tmp/pi-pack/fleetagent-pi-coding-agent-*.tgz \
	&& rm -rf /tmp/pi-pack

RUN mkdir -p /workspace/src /workspace/.pi/skills /workspace/.pi/skills/remote-container \
	&& printf '# Remote pi daemon test project\n\nThis project is inside the pi --daemon Docker container.\n' > /workspace/README.md \
	&& printf '# Project Instructions\n\nYou are working inside the pi --daemon Docker test container. Use tools normally; file and shell operations run in /workspace.\n' > /workspace/AGENTS.md \
	&& printf 'export function hello(name: string): string {\n\treturn `hello ${name}`;\n}\n' > /workspace/src/hello.ts \
	&& printf '%s\n' '---' 'description: This intentionally malformed skill is missing name frontmatter.' '---' '' '# Malformed container skill' '' 'This file should appear as a skill loading diagnostic, not as a loaded skill.' > /workspace/.pi/skills/container.md \
	&& printf '%s\n' '---' 'name: remote-container' 'description: Mention that the skill came from the remote container.' '---' '' '# Remote container skill' '' 'When this skill is loaded, mention that it came from the remote container.' > /workspace/.pi/skills/remote-container/SKILL.md

ENV PI_DAEMON_HOST=0.0.0.0
ENV PI_DAEMON_PORT=8787
ENV PI_DAEMON_CWD=/workspace
ENV PI_DAEMON_TOKEN=dev-token-dev-token-dev-token-dev-token
ENV PI_DAEMON_ALLOW_INSECURE_TRANSPORT=1
ENV PI_DAEMON_ALLOW_PROCESS_EXEC=1

WORKDIR /workspace
EXPOSE 8787

CMD ["pi", "--daemon"]

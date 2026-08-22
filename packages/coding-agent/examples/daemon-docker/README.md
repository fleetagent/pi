# pi --daemon Docker test target

Build and run a local container that exposes the integrated Pi remote workspace daemon on port 8787.

From the repo root:

```bash
docker build -f packages/coding-agent/examples/daemon-docker/Dockerfile -t pi-remote-daemon-test .
docker run --rm -p 8787:8787 --name pi-remote-daemon-test pi-remote-daemon-test
```

The image installs the packaged `@fleetagent/pi-coding-agent` tarball and starts `pi --daemon`. It uses a fixed development token, enables process execution for shell-tool testing, and binds to `0.0.0.0` inside the container.

In another terminal, start Pi directly against the container:

```bash
PI_REMOTE_TOKEN=dev-token-dev-token-dev-token-dev-token ./pi-test.sh --remote ws://127.0.0.1:8787/pi/workspace
```

Or start with a deferred backend and connect from inside Pi:

```bash
./pi-test.sh --remote-deferred --remote-cwd /workspace
```

Then run:

```text
/sandbox --attach ws://127.0.0.1:8787/pi/workspace
```

Useful prompts:

```text
List the files in this project and read AGENTS.md
Run pwd and uname -a
Use /skill:remote-container and tell me where the skill came from
Edit src/hello.ts to add an exclamation mark
```

Stop the container with Ctrl-C, or from another terminal:

```bash
docker stop pi-remote-daemon-test
```

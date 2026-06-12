# pi-daemon Docker test target

Build and run a local container that exposes the pi remote commander protocol on port 8787.

From the repo root:

```bash
docker build -f packages/pi-daemon/examples/docker/Dockerfile -t pi-daemon-test .
docker run --rm -p 8787:8787 --name pi-daemon-test pi-daemon-test
```

In another terminal, start pi directly against the container:

```bash
./pi-test.sh --remote ws://127.0.0.1:8787
```

Or start with a deferred backend and connect from inside pi:

```bash
./pi-test.sh --remote-deferred --remote-cwd /workspace
```

Then run:

```text
/remote daemon ws://127.0.0.1:8787
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
docker stop pi-daemon-test
```

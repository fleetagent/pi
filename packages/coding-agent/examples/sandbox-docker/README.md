# Pi sandbox Docker image

This image is the base runtime for `/sandbox start`. It contains the packaged `pi` CLI and starts the integrated workspace daemon with `pi --daemon`.

## Build from a local release

Create local release artifacts from the repository root:

```bash
npm run release:local -- --out /tmp/pi-local-release --force
```

Build the image with the local release directory as the Docker context:

```bash
docker build \
  -f packages/coding-agent/examples/sandbox-docker/Dockerfile \
  -t pi-sandbox:local \
  /tmp/pi-local-release
```

The Dockerfile consumes `/tmp/pi-local-release/node`, which is the isolated npm install produced from the locally packed tarballs. Do not use `--skip-install`; a tarball-only release does not contain the `node/` install directory the Dockerfile copies.

If you use a different directory name inside the build context, pass it explicitly:

```bash
docker build \
  --build-arg PI_RELEASE_NODE_DIR=my-node-install \
  -f packages/coding-agent/examples/sandbox-docker/Dockerfile \
  -t pi-sandbox:local \
  /path/to/context
```

## Runtime defaults

The image sets:

- workspace directory: `/workspace`
- daemon command: `pi --daemon`
- daemon host inside the container: `0.0.0.0`
- daemon port inside the container: `8787`
- process execution: enabled for Pi shell/tool execution inside the container
- user: unprivileged `pi` user with uid `1000`

`PI_DAEMON_TOKEN` is intentionally not baked into the image. `/sandbox start` generates a token and passes it through the container environment. For manual runs, provide a long random token yourself:

```bash
docker run --rm \
  --name pi-sandbox-local \
  -p 127.0.0.1:8787:8787 \
  -e PI_DAEMON_TOKEN=dev-token-dev-token-dev-token-dev-token \
  -v "$PWD:/workspace" \
  pi-sandbox:local
```

Then connect a local Pi process as the orchestrator:

```bash
PI_REMOTE_TOKEN=dev-token-dev-token-dev-token-dev-token ./pi-test.sh --remote ws://127.0.0.1:8787/pi/workspace
```

## Use with `/sandbox start`

Override the sandbox image for one start:

```text
/sandbox start --image pi-sandbox:local
```

Or configure the default image with normal sandbox precedence:

```bash
PI_SANDBOX_IMAGE=pi-sandbox:local ./pi-test.sh
```

The sandbox service mounts the current workspace at `/workspace`, publishes the container daemon port to a loopback host port, and supplies `PI_DAEMON_TOKEN` through the Docker environment. Tokens must not be put in image layers, command-line arguments, labels, or URLs. See [Docker Sandbox](../../docs/sandbox.md) for `/sandbox start|list|stop`, configuration precedence, stop behavior, troubleshooting, and security boundaries.

## Notes

- The image uses the integrated `pi --daemon` command from `@fleetagent/pi-coding-agent`.
- The mounted workspace is read/write. Files created by the container are owned by uid `1000` unless Docker is run with a different user policy.
- Docker is not a complete security boundary. Treat this image and any override image as trusted code for the mounted workspace.

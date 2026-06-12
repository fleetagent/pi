# @fleetagent/pi-daemon

Remote commander daemon for Pi. It listens for Pi's WebSocket remote tool protocol and executes file and shell operations in its working directory.

## Install

```bash
npm install -g @fleetagent/pi-daemon
```

## Run

```bash
PI_DAEMON_TOKEN=secret \
PI_DAEMON_CWD=/workspace \
PI_DAEMON_PORT=8787 \
pi-daemon
```

Defaults:

- `PI_DAEMON_HOST` / `HOST`: `127.0.0.1`
- `PI_DAEMON_PORT` / `PORT`: `8787`
- `PI_DAEMON_CWD`: current directory
- `PI_DAEMON_TOKEN`: optional bearer token

## Connect from Pi

Direct:

```bash
pi --remote 'ws://127.0.0.1:8787?token=secret'
```

Deferred:

```bash
pi --remote-deferred --remote-cwd /workspace
```

Then inside Pi:

```text
/remote daemon ws://127.0.0.1:8787?token=secret
```

## File transfers

The daemon protocol supports streamed file upload and download for binary and text files:

- `downloadFile` streams `{ event: "fileData", dataBase64 }` chunks followed by `fileEnd`.
- `uploadFileStart`, `uploadFileChunk`, and `uploadFileEnd` write chunked base64 data to a sandbox file.

Pi RPC exposes these as `upload_file` and `download_file` commands when the daemon is configured as the remote sandbox backend.

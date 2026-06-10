# pi-landstrip

![pi-landstrip screenshot](screenshot.png)

Landlock-based sandboxing for [pi](https://pi.dev/) using
[`landstrip`](https://github.com/jarkkojs/landstrip).

## Install

```bash
pi install npm:pi-landstrip
```

This installs `pi-landstrip` and its `@jarkkojs/landstrip` dependency, which
includes platform-specific native binaries for Linux, macOS, and Windows.

On unsupported platforms the extension loads but leaves sandboxing disabled.

## Configure

Create `.pi/sandbox.json` in a project or `~/.pi/agent/sandbox.json` globally.
Project config takes precedence.

See [`sandbox.json`](./sandbox.json) for a starter config.

## Usage

```bash
pi --no-sandbox
```

Use `/sandbox` inside Pi to show the active config.

## License

`pi-landstrip` is licensed under `MIT`. See [LICENSE](LICENSE) for more
information.

# Continuous integration

The `Bun CI` workflow has six jobs: the repository test command and the web
production build on Ubuntu, Windows, and macOS. Run the commands below from the
repository root. The browser-backed real-video milestone is not part of this
baseline; `bun run test` reports it as skipped unless its integration variables
are explicitly configured.

## Common setup

Every job uses Bun 1.2.18, the current stable Rust toolchain, the
`wasm32-unknown-unknown` target, and wasm-pack 0.15.0:

```text
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
bun install --frozen-lockfile
rustc --version
cargo --version
wasm-pack --version
bun --version
```

The test jobs also compile the desktop shell and run export validation. Install
and verify their native dependencies with the commands for the target runner:

### Ubuntu

```bash
bash apps/desktop/script/setup
sudo apt-get install -y ffmpeg
ffmpeg -version
ffprobe -version
```

### macOS

```bash
bash apps/desktop/script/setup
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

### Windows PowerShell

```powershell
./apps/desktop/script/setup.ps1
choco install ffmpeg --no-progress -y
ffmpeg -version
ffprobe -version
```

## Reproduce each job

The test pool limits are part of the CI contract. They keep each stateful MCP
suite in its own process while preventing hosted-runner contention; web suites
that use `mock.module` continue to run one suite per Bun process.

| GitHub Actions job           | Local command                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `test (ubuntu-latest)`       | `OPENCUT_TEST_MCP_WORKERS=1 OPENCUT_TEST_WEB_WORKERS=4 bun run test`                 |
| `test (macos-latest)`        | `OPENCUT_TEST_MCP_WORKERS=1 OPENCUT_TEST_WEB_WORKERS=4 bun run test`                 |
| `test (windows-latest)`      | `$env:OPENCUT_TEST_MCP_WORKERS='1'; $env:OPENCUT_TEST_WEB_WORKERS='4'; bun run test` |
| `build-web (ubuntu-latest)`  | Set the build variables below, then run `bun run build:web`.                         |
| `build-web (macos-latest)`   | Set the build variables below, then run `bun run build:web`.                         |
| `build-web (windows-latest)` | Set the build variables below, then run `bun run build:web`.                         |

Ubuntu and macOS use:

```bash
export DATABASE_URL='postgresql://opencut:opencut@localhost:5432/opencut'
export BETTER_AUTH_SECRET='ci-only-not-a-production-secret-1234567890'
export NEXT_PUBLIC_SITE_URL='http://localhost:3000'
export UPSTASH_REDIS_REST_URL='https://your-upstash-redis-url'
export UPSTASH_REDIS_REST_TOKEN='your-upstash-redis-token'
export NEXT_PUBLIC_MARBLE_API_URL='https://placeholder.example.com'
export MARBLE_WORKSPACE_KEY='placeholder'
export FREESOUND_CLIENT_ID='placeholder'
export FREESOUND_API_KEY='placeholder'
bun run build:web
```

Windows PowerShell uses:

```powershell
$env:DATABASE_URL='postgresql://opencut:opencut@localhost:5432/opencut'
$env:BETTER_AUTH_SECRET='ci-only-not-a-production-secret-1234567890'
$env:NEXT_PUBLIC_SITE_URL='http://localhost:3000'
$env:UPSTASH_REDIS_REST_URL='https://your-upstash-redis-url'
$env:UPSTASH_REDIS_REST_TOKEN='your-upstash-redis-token'
$env:NEXT_PUBLIC_MARBLE_API_URL='https://placeholder.example.com'
$env:MARBLE_WORKSPACE_KEY='placeholder'
$env:FREESOUND_CLIENT_ID='placeholder'
$env:FREESOUND_API_KEY='placeholder'
bun run build:web
```

`bun run build:web` builds the `opencut-wasm` workspace dependency through
Turbo before invoking the Next.js production build. Do not run a second manual
WASM build when reproducing the web job.

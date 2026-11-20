// YourOwn Live development runner (Vite + Electron)
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const binExt = process.platform === 'win32' ? '.cmd' : '';

function binPath(name) {
  return path.join(rootDir, 'node_modules', '.bin', `${name}${binExt}`);
}

function runBin(name, args, extraEnv = {}) {
  return spawn(binPath(name), args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 250);
      });
    };
    check();
  });
}

async function main() {
  const tsc = runBin('tsc', ['-p', 'tsconfig.electron.json']);
  await new Promise((resolve, reject) => {
    tsc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron TypeScript build failed with code ${code}`));
    });
  });

  const vite = runBin('vite', []);
  await waitForServer('http://localhost:5173');

  const electronProc = runBin('electron', ['.'], {
    VITE_DEV_SERVER_URL: 'http://localhost:5173',
  });

  const cleanup = () => {
    if (!vite.killed) vite.kill();
    if (!electronProc.killed) electronProc.kill();
  };

  electronProc.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

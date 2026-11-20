// YourOwn Live development runner (Vite + Electron)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function resolveCommand(name, args) {
  if (name === 'tsc') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), ...args],
    };
  }
  if (name === 'vite') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), ...args],
    };
  }
  if (name === 'electron') {
    // Electron's package exports the exact platform executable path (no .cmd wrapper needed)
    const electronPath = require('electron');
    return {
      command: String(electronPath),
      args,
    };
  }
  const binExt = process.platform === 'win32' ? '.cmd' : '';
  const bin = path.join(rootDir, 'node_modules', '.bin', `${name}${binExt}`);
  if (process.platform === 'win32') {
    const quoted = [bin, ...args].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${quoted}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: bin, args };
}

function runBin(name, args, extraEnv = {}) {
  const resolved = resolveCommand(name, args);
  return spawn(resolved.command, resolved.args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
    windowsVerbatimArguments: Boolean(resolved.windowsVerbatimArguments),
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

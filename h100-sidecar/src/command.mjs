import { spawn } from 'node:child_process';

export function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, signal, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8') };
      if (result.code !== 0 && !options.allowFailure) {
        const error = new Error(`${file} exited with ${result.code}`); error.result = result; reject(error);
      } else resolve(result);
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
  });
}

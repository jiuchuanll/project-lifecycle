import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 1_048_576;

export const createProcessRunner = () => Object.freeze({
  runProcess: async (command, args = [], options = {}) => {
    if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)
      || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      return { ok: false, code: null, stdout: '', stderr: '', error: 'PROCESS_INPUT_INVALID' };
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let overflow = false;
      let settled = false;
      let timedOut = false;
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
        : null;
      const append = (current, chunk) => {
        if (Buffer.byteLength(current) + chunk.length > MAX_OUTPUT_BYTES) {
          overflow = true;
          child.kill('SIGKILL');
          return current;
        }
        return current + chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      child.on('error', () => finish({ ok: false, code: null, stdout: '', stderr: '', error: 'PROCESS_START_FAILED' }));
      child.on('close', (code) => finish({
        ok: code === 0 && !overflow && !timedOut,
        code,
        stdout,
        stderr,
        ...(timedOut ? { error: 'PROCESS_TIMEOUT' } : overflow ? { error: 'PROCESS_OUTPUT_LIMIT' } : {}),
      }));
    });
  },
});

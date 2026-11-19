import { spawn } from 'node:child_process';

const children = [
  spawn('node', ['--env-file=.env', '--watch', 'server/index.mjs'], { stdio: 'inherit' }),
  spawn('node', ['--env-file=.env', '--watch', 'server/worker.mjs'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(child => child.kill('SIGTERM'));
  process.exitCode = code;
}
children.forEach(child => child.on('exit', code => close(code || 0)));
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());

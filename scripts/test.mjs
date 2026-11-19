import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {randomUUID} from 'node:crypto';
import {createClient} from 'redis';

// Each file owns a Redis limiter namespace; the existing worker processes its synthetic jobs.
// Production limits remain enabled and unchanged.
let api, checks, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true; checks?.kill(signal); api?.kill(signal);
});
for (const file of readdirSync('tests').filter(f => !f.startsWith('.') && f.endsWith('.test.mjs')).sort()) {
  if (interrupted) { process.exitCode = 1; break; }
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const namespace=randomUUID();
  const env = { ...process.env, NODE_ENV:'test', TEST_RATE_LIMIT_NAMESPACE:namespace, PORT: String(port), TEST_API_ORIGIN: `http://127.0.0.1:${port}` };
  if(file==='outreach.test.mjs')Object.assign(env,{
    OUTREACH_LLM_URL:'https://example.test/v1/chat/completions',
    OUTREACH_LLM_MODEL:'test-model',
    OUTREACH_LLM_API_KEY:'test-only-key'
  });
  api = spawn(process.execPath, ['--env-file=.env', 'server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test API did not start.')), 10000);
      api.stdout.on('data', bytes => { if (bytes.toString().includes('API ready')) { clearTimeout(timer); resolve(); } });
      api.once('error', error => { clearTimeout(timer); reject(error); });
      api.once('exit', () => { clearTimeout(timer); reject(new Error('Test API exited before readiness.')); });
    });
    checks = spawn(process.execPath, ['--env-file=.env', '--test', `tests/${file}`], { env, stdio: 'inherit' });
    const [code] = await once(checks, 'exit'); checks = null;
    if (code !== 0) process.exitCode = 1;
  } finally {
    if (api.exitCode === null && api.signalCode === null) { const ended = once(api, 'exit'); api.kill('SIGTERM'); await ended; }
    api = null;
    const redis=createClient({url:process.env.REDIS_URL,socket:{connectTimeout:1500,reconnectStrategy:false},commandOptions:{timeout:1500}});redis.on('error',()=>{});
    try{await redis.connect();for await(const keys of redis.scanIterator({MATCH:`drykraft:rate:test:${namespace}:*`,COUNT:100}))if(keys.length)await redis.del(keys);}finally{if(redis.isOpen)redis.destroy();}
  }
}

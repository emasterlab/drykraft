import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { currencyOptions } from '../server/currency.mjs';
import { renderWebsite, websitePages } from '../server/website.mjs';

const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source, 'api.ts');
const { api, ApiError } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('API failures retain recovery messages and cancellation semantics', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api('/test'), e => e instanceof ApiError && e.status === 0 && /connection/.test(e.message));
    globalThis.fetch = async () => new Response('<html>Unavailable</html>', { status: 502 });
    await assert.rejects(api('/test'), e => e instanceof ApiError && e.status === 502 && /try again/.test(e.message));
    globalThis.fetch = async () => new Response('Too many requests', { status: 429 });
    await assert.rejects(api('/test'), e => e instanceof ApiError && e.status === 429 && /Wait a minute/.test(e.message));
    globalThis.fetch = async () => Response.json({ error: { message: 'This record changed. Refresh it before saving.' } }, { status: 409 });
    await assert.rejects(api('/test'), e => e instanceof ApiError && e.status === 409 && /record changed/.test(e.message));
    globalThis.fetch = async () => Response.json(null, { status: 500 });
    await assert.rejects(api('/test'), e => e instanceof ApiError && e.status === 500);
    const cancelled = new DOMException('Cancelled', 'AbortError');
    globalThis.fetch = async () => { throw cancelled; };
    await assert.rejects(api('/test'), e => e === cancelled);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw cancelled; } });
    await assert.rejects(api('/test'), e => e === cancelled);
    globalThis.fetch = async () => Response.json({ items: ['ready'] });
    assert.deepEqual(await api('/test'), { items: ['ready'] });
  } finally { globalThis.fetch = original; }
});

test('owned product copy and all public page titles use hyphens', () => {
  function check(dir) {
    for (const item of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const path = dir + '/' + item.name;
      if (item.isDirectory()) check(path);
      else if (/\.(tsx?|m?js|css|html)$/.test(item.name)) assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /—|&mdash;|&#(?:8212|x2014);|\\u2014/, path);
    }
  }
  assert.ok(currencyOptions.every(c => !c.name.includes('—')), 'Locale-generated currency labels also use hyphens');
  for (const dir of ['../src', '../server', '../public']) check(dir);
  assert.doesNotMatch(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /—/);
  for (const page of websitePages) {
    const html = renderWebsite(page, { appOrigin: 'https://app.drykraft.com', siteOrigin: 'https://drykraft.com' });
    assert.doesNotMatch(html, /—|&mdash;/);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    assert.equal((html.match(/aria-current="page"/g) || []).length, page.path === '/' ? 0 : 1);
    assert.match(html, /<title>[^<]+ - DryKraft<\/title>/);
    assert.match(html, /<main id="main" tabindex="-1">/);
  }
});


test('public detail pages have unique metadata and valid internal destinations', () => {
  const paths=new Set(websitePages.map(p=>p.path)), titles=new Set(), descriptions=new Set();
  for(const page of websitePages) {
    const html=renderWebsite(page,{siteOrigin:'https://drykraft.com',appOrigin:'https://app.drykraft.com'});
    const title=html.match(/<title>(.*?)<\/title>/)[1], description=html.match(/name="description" content="([^"]*)"/)[1];
    assert.ok(!titles.has(title));assert.ok(!descriptions.has(description));titles.add(title);descriptions.add(description);
    for(const [,href] of html.matchAll(/href="(\/[^"#]*)(?:#[^"]*)?"/g)) {
      if(href==='/docs/openapi.json'||existsSync(new URL('../public'+href,import.meta.url))||existsSync(new URL('../dist'+href,import.meta.url)))continue;
      assert.ok(paths.has(href), `${page.path} links to an unknown page: ${href}`);
    }
    for(const [,path,fragment] of html.matchAll(/href="(\/[^"#]+)#([^"]+)"/g)) { const target=websitePages.find(p=>p.path===path); assert.ok(target&&renderWebsite(target).includes(`id="${fragment}"`), `${page.path} links to a missing chapter section: ${path}#${fragment}`); }
    for(const [,fragment] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${fragment}"`), `${page.path} has a broken section link: ${fragment}`);
  }
});


test('website exposes every released outreach channel and account security with accurate product limits',()=>{
  const html=path=>renderWebsite(websitePages.find(p=>p.path===path),{appOrigin:'https://app.drykraft.com'});
  for(const path of ['/product/outreach','/product/email-outreach','/product/sms-outreach','/product/ai-voice','/product/whatsapp','/product/account-security'])assert.ok(html('/').includes('href="'+path+'"'));
  assert.match(html('/product/outreach'),/up to 500 contacts/);
  assert.match(html('/product/whatsapp'),/24-hour conversation window/);
  assert.match(html('/pricing'),/providers may charge separately/);
  assert.doesNotMatch(html('/about'),/lead outreach, social media, communication providers.*remain in development/);
  assert.doesNotMatch(html('/product/crm'),/conversion creates connected customer and deal/);
});

test('practical guides remain discoverable and explain reviewed actions and their consequences',()=>{
  const render=path=>renderWebsite(websitePages.find(p=>p.path===path),{appOrigin:'https://app.drykraft.com'});
  for(const path of ['/guides/outreach-setup','/guides/first-workflow','/guides/team-and-security','/guides/trial-and-billing']){
    assert.match(render(path),/aria-label="On this page"/);
    assert.ok(render('/guides').includes(`href="${path}"`));
    assert.ok(render('/').includes(`href="${path}"`));
    assert.equal((render(path).match(/<article id="step-/g)||[]).length,4);
  }
  assert.match(render('/guides/outreach-setup'),/Reviewing sends nothing/);
  assert.match(render('/guides/first-workflow'),/Later draft edits do not change the version/);
  assert.match(render('/guides/team-and-security'),/does not automatically send an invitation email/);
  assert.match(render('/guides/trial-and-billing'),/signup does not automatically charge/);
});

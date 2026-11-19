import { mkdir,writeFile,copyFile,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { websitePages,renderWebsite } from '../server/website.mjs';
import { openApiDocument } from '../server/api-documentation.mjs';

if(existsSync('.env'))process.loadEnvFile('.env');
const production=process.env.NODE_ENV==='production';
const siteOrigin=process.env.WEBSITE_ORIGIN || (production?`https://${process.env.APP_DOMAIN}`:'');
const appOrigin=process.env.APP_ORIGIN || '';
await mkdir('dist/fonts',{recursive:true});
await copyFile('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2','dist/fonts/inter-latin.woff2');
await mkdir('dist/docs',{recursive:true});
await writeFile('dist/docs/openapi.json',JSON.stringify(openApiDocument(),null,2));
await rm('dist/site/pricing',{recursive:true,force:true});
for(const page of websitePages){
  const dir=`dist/site${page.path==='/'?'':page.path}`;await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/index.html`,renderWebsite(page,{siteOrigin,appOrigin}));
}
await writeFile('dist/robots.txt',`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /login\nDisallow: /signup\nDisallow: /crm/\nDisallow: /sales/\nDisallow: /finance/\nDisallow: /outreach/\nDisallow: /automation/\nDisallow: /settings/\n${siteOrigin?`Sitemap: ${siteOrigin}/sitemap.xml\n`:''}`);
await writeFile('dist/sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${siteOrigin?websitePages.map(p=>`<url><loc>${siteOrigin}${p.path}</loc></url>`).join(''):''}</urlset>`);
console.log(`Built ${websitePages.length} public website pages alongside the React application.`);

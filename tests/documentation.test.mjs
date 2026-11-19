import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiOperations,openApiDocument } from '../server/api-documentation.mjs';
import { docsPages } from '../server/documentation.mjs';
import { renderWebsite,websitePages } from '../server/website.mjs';

test('public API reference covers every implemented method/path and only implemented routes',()=>{
  const mounts={index:['app',''],finance:['financeRouter','/api/finance'],templates:['templatesRouter','/api/templates'],'record-tools':['recordToolsRouter','/api/record-tools'],'record-lists':['recordListsRouter','/api/record-lists'],team:['teamRouter','/api/settings','invitationRouter','/api/auth/invitations'],account:['accountRouter','/api/account'],'developer-access':['developerRouter','/api/developer'],'customer-webhooks':['customerWebhookRouter','/api/developer/webhooks'],'versioned-api':['versionedApiRouter','/api/v1'],billing:['billingRouter','/api/billing'],'routes-automation':['automationRouter','/api/automation'],'routes-calendar':['calendarRouter','/api/calendar','calendarPublicRouter','/api/calendar'],'routes-outreach':['outreachRouter','/api/outreach','outreachPublicRouter','/api/outreach']};
  mounts.mfa=['router','/api/account'];
  mounts.organization=['organizationRouter','/api/settings/organization'];
  mounts.platform=['platformRouter','/api/sa'];
  mounts['platform-auth']=['router','/api/sa'];
  mounts['platform-customers']=['router','/api/sa'];
  mounts['platform-commercial']=['router','/api/sa'];
  mounts['platform-mail']=['router','/api/sa'];
  mounts['platform-resellers']=['router','/api/sa'];
  mounts['platform-reseller-keys']=['router','/api/sa'];
  mounts['reseller-auth']=['router','/api/reseller'];
  mounts.reseller=['resellerRouter','/api/reseller'];
  mounts['reseller-team']=['platformTeamRouter','/api/sa','staffTeamRouter','/api/reseller'];
  mounts['reseller-plans']=['staffPlansRouter','/api/reseller'];
  mounts['reseller-customers']=['customerRouter','/api/reseller'];
  mounts['reseller-api']=['resellerApiRouter','/api/v1/reseller'];
  mounts['platform-invitations']=['router','/api/auth/platform-invitations'];
  const actual=[];
  for(const [file,entries] of Object.entries(mounts)){
    const source=readFileSync(new URL('../server/'+file+'.mjs',import.meta.url),'utf8');
    // Literal routes plus explicitly declared path-array routes; unsupported declarations cannot disappear from this inventory.
    for(const [,router,method,,route] of source.matchAll(/\b(\w+)\.(get|post|put|delete|patch)\(\s*(['"])(\/[^'"]*)\3/g)){
      const index=entries.indexOf(router);
      if(index>=0){const path=entries[index+1]+route;if(path.startsWith('/api/'))actual.push(method.toUpperCase()+' '+path.replace(/:([A-Za-z_]+)/g,'{$1}'));
        if(file==='platform-invitations'){
          assert.match(source,/platformInvitationRouter=ownerInvitationRouter\('platform'\)/);
          assert.match(source,/resellerInvitationRouter=ownerInvitationRouter\('reseller'\)/);
          assert.match(readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8'),/app\.use\('\/api\/auth\/reseller-invitations',authLimit,resellerInvitationRouter\)/);
          actual.push(method.toUpperCase()+' /api/auth/reseller-invitations'+route);
        }
      }
    }
    for(const [,router,method,name]of source.matchAll(/\b(\w+)\.(get|post|put|delete|patch)\(\s*([A-Za-z_]+)\s*,/g)) {
      const index=entries.indexOf(router);if(index<0)continue;
      const declaration=new RegExp('\\b'+name+'=\\[([^\\]]*)\\]').exec(source);assert.ok(declaration,'Document the dynamic route contract for '+name);
      const paths=[...declaration[1].matchAll(/['"](\/[^'"]*)['"]/g)].map(m=>m[1]);assert.ok(paths.length);
      for(const path of paths)actual.push(method.toUpperCase()+' '+(entries[index+1]+path).replace(/:([A-Za-z_]+)/g,'{$1}'));
    }
  }
  const documented=apiOperations.map(o=>o.method+' '+o.path);
  assert.equal(new Set(documented).size,documented.length,'Duplicate contracts');
  assert.deepEqual(documented.sort(),actual.sort());
  const spec=openApiDocument();
  for(const op of apiOperations){assert.ok(op.description.length>20);assert.ok(op.access);assert.ok(spec.paths[op.path][op.method.toLowerCase()]);}
  function refs(value){if(value&&typeof value==='object'){if(value.$ref)assert.ok(spec.components.schemas[value.$ref.split('/').at(-1)],value.$ref);Object.values(value).forEach(refs);}}refs(spec);
});

test('documentation pages and cross-page anchors resolve without exposing implementation secrets',()=>{
  const rendered=new Map(websitePages.map(p=>[p.path,renderWebsite(p,{siteOrigin:'https://drykraft.com',appOrigin:'https://app.drykraft.com'})]));
  for(const page of docsPages){
    const html=rendered.get(page.path);
    assert.ok(html.includes('Browse documentation'));
    assert.ok(!html.includes('class="closing"'));
    assert.doesNotMatch(html,/whsec_|b894c848|postgres\/postgres|BEGIN.*PRIVATE KEY/);
    for(const [,href] of html.matchAll(/href="(\/docs[^" ]*)"/g)){
      if(href==='/docs/openapi.json')continue;
      const [path,fragment]=href.split('#');assert.ok(rendered.has(path),href);
      if(fragment)assert.ok(rendered.get(path).includes(`id="${fragment}"`),href);
    }
    for(const [,fragment] of html.matchAll(/href="#([^" ]+)"/g))assert.ok(html.includes(`id="${fragment}"`),fragment);
  }
});

test('platform contracts require their separate cookie and production origin, and document provisioning replay without customer authority',()=>{
 const spec=openApiDocument(),rendered=renderWebsite(docsPages.find(p=>p.path==='/docs/api/platform'));
 assert.equal(spec.components.securitySchemes.platformSession.name,'drykraft_sa_session');
 for(const operation of apiOperations.filter(o=>o.path.startsWith('/api/sa/'))){
  const contract=spec.paths[operation.path][operation.method.toLowerCase()];
  assert.deepEqual(contract.security,operation.access==='Public'?[]:[{platformSession:[]}]);
  if(['POST','PUT'].includes(operation.method))assert.ok(contract.parameters.some(p=>p.name==='Origin'&&p.required&&p.schema.const==='https://app.drykraft.com'));
 }
 assert.ok(spec.paths['/api/sa/workspaces'].post.responses[200]);
 assert.equal(spec.paths['/api/sa/workspaces'].post.requestBody.content['application/json'].schema.additionalProperties,false);
 assert.match(rendered,/drykraft_sa_session=&lt;YOUR_SESSION_TOKEN&gt;/);assert.match(rendered,/Origin: https:\/\/app.drykraft.com/);
 assert.equal(spec.paths['/api/auth/platform-invitations/accept'].post.security.length,0);
 assert.match(spec.paths['/api/auth/platform-invitations/accept'].post.description,/MFA/);
});

test('reseller reference uses its dedicated Bearer identity and documents one-time key replay and read-only boundaries',()=>{
 const spec=openApiDocument(),page=renderWebsite(docsPages.find(p=>p.path==='/docs/api/reseller-api'));
 for(const operation of apiOperations.filter(o=>o.group==='reseller-api'))assert.deepEqual(spec.paths[operation.path].get.security,[{resellerKey:[]}]);
 assert.match(page,/Authorization: Bearer/);assert.ok(!page.includes('--cookie'));
 assert.match(spec.components.securitySchemes.resellerKey.description,/No customer CRM or platform identity/);
 assert.ok(spec.paths['/api/sa/resellers/{id}/api-keys'].post.responses[200]);
 assert.match(spec.paths['/api/sa/resellers/{id}/api-keys'].post.description,/secret=null/);
 assert.equal(spec.paths['/api/sa/resellers/{id}/api-keys/creations/{requestId}'].get.responses[200].content['application/json'].schema.properties.secret.type,'null');
 assert.deepEqual(spec.paths['/api/sa/resellers/{id}/api-keys/{keyId}'].get.security,[{platformSession:[]}]);
 assert.match(spec.paths['/api/v1/reseller/customers'].get.description,/No users, memberships, CRM/);
 assert.match(spec.paths['/api/v1/reseller/usage'].get.description,/No consumed credits/);
});

test('reseller staff reference keeps browser MFA and platform identities separate with complete team retry contracts',()=>{
 const spec=openApiDocument(),page=renderWebsite(docsPages.find(p=>p.path==='/docs/api/reseller-staff'));
 assert.equal(spec.components.securitySchemes.resellerSession.name,'drykraft_reseller_session');
 for(const operation of apiOperations.filter(o=>o.path.startsWith('/api/reseller/'))){
  const contract=spec.paths[operation.path][operation.method.toLowerCase()];
  assert.deepEqual(contract.security,operation.access==='Public'?[]:[{resellerSession:[]}]);
  if(['POST','PUT'].includes(operation.method))assert.ok(contract.parameters.some(p=>p.name==='Origin'&&p.required&&p.schema.const==='https://app.drykraft.com'));
 }
 for(const path of ['/api/reseller/members','/api/sa/resellers/{id}/members']){
  assert.ok(spec.paths[path].post.responses[200]);assert.equal(spec.paths[path].post.requestBody.content['application/json'].schema.oneOf.length,2);
 }
 assert.match(page,/drykraft_reseller_session=&lt;YOUR_SESSION_TOKEN&gt;/);
 assert.match(page,/Origin: https:\/\/app.drykraft.com/);
 assert.match(page,/first enabled team member must be an owner/);
 assert.equal(spec.paths['/api/sa/resellers/{id}/members/{memberId}'].put.parameters.find(p=>p.name==='memberId').schema.format,'uuid');
 for(const path of ['/api/reseller/plans','/api/reseller/plans/{id}/versions']){
  assert.ok(spec.paths[path].post.responses[200]);assert.ok(spec.paths[path].post.responses[201]);
  assert.ok(spec.paths[path].post.requestBody.content['application/json'].schema.required.includes('request_id'));
 }
 assert.match(spec.paths['/api/reseller/plans/{id}/versions'].post.description,/remain pinned/);
 assert.match(spec.paths['/api/reseller/plans/publications/{requestId}'].get.description,/original currently authorized/);
 for(const path of ['/api/reseller/members/creations/{requestId}','/api/sa/resellers/{id}/members/creations/{requestId}'])assert.match(spec.paths[path].get.description,/original currently authorized/);
 const allowance=spec.paths['/api/reseller/plans/allowance'].get.responses[200].content['application/json'].schema;assert.ok(allowance.required.includes('trial_days_max'));assert.equal(allowance.properties.limits.additionalProperties,false);
});


test('composed response fields and conditional OAuth parameters survive both reference formats',()=>{
  const rendered=path=>renderWebsite(docsPages.find(p=>p.path===path));
  assert.match(rendered('/docs/api/records'),/schemas#schema-Object[^>]*>Object<\/a>\[\]/);
  assert.match(rendered('/docs/api/automation'),/Use <a[^>]*schemas#schema-Execution/);
  assert.match(rendered('/docs/api/outreach-campaigns'),/Use <a[^>]*schemas#schema-Campaign/);
  const parameters=openApiDocument().paths['/api/outreach/oauth/{provider}/callback'].get.parameters;
  assert.equal(parameters.find(p=>p.name==='state').required,true);
  assert.equal(parameters.find(p=>p.name==='code').required,false);
  assert.match(parameters.find(p=>p.name==='code').schema.description,/when error is absent/);
  assert.match(rendered('/docs/api/webhooks'),/<code>code<\/code><\/th><td>string<\/td><td>No<\/td><td>Required when error is absent/);
  assert.deepEqual(openApiDocument().paths['/api/v1/{resource}'].post.security,[{bearerKey:[]}]);
  assert.equal(openApiDocument().paths['/api/v1/{resource}'].post.parameters.find(p=>p.name==='Idempotency-Key').required,true);
  assert.match(rendered('/docs/api/versioned-crm'),/Authorization: Bearer/);assert.match(rendered('/docs/api/versioned-crm'),/Idempotency-Key:/);
  assert.ok(!rendered('/docs/api/versioned-crm').includes('--cookie'));
  assert.match(rendered('/docs/api/customer-webhooks'), /--url[^\n]*\/deliveries\/00000000-0000-4000-8000-000000000001\/replay/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import {campaignEmail} from '../src/lib/campaign-email.mjs';
import {sendProvider} from '../server/outreach-providers.mjs';

function alternative(mime,type){
 const boundary=mime.match(/boundary="([^"]+)"/)?.[1];assert.ok(boundary,'Email must have a multipart alternative boundary.');
 const part=mime.split('--'+boundary).find(part=>new RegExp('Content-Type: text/'+type+';','i').test(part));assert.ok(part,'Missing '+type+' alternative.');
 const [headers,...content]=part.split('\r\n\r\n'),raw=content.join('\r\n\r\n').trimEnd();
 if(/Content-Transfer-Encoding: base64/i.test(headers))return Buffer.from(raw,'base64').toString('utf8');
 return Buffer.from(raw.replace(/=\r?\n/g,'').replace(/=([\da-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),'latin1').toString('utf8');
}
test('formatted campaign emails preserve paragraphs, lists, links, identity and a plain-text alternative',()=>{
 const body='Hi Asha,\r\n\r\nHere is your update:\r\n\r\n- First item\r\n- Second item\r\n\r\nLearn more: https://example.test/details?a=1&b=2.\r\nThanks,\r\nOur team';
 const result=campaignEmail({subject:'Your update',body,senderName:'Example & Co',senderEmail:'team@example.test',unsubscribeUrl:'https://example.test/unsubscribe?token=abc&channel=email'});
 assert.match(result.html,/<h1[^>]*>Your update<\/h1>/);assert.match(result.html,/Example &amp; Co/);assert.match(result.html,/<ul[^>]*><li[^>]*>First item<\/li>/);
 assert.match(result.html,/Thanks,<br>Our team/);assert.match(result.html,/href="https:\/\/example.test\/details\?a=1&amp;b=2"/);assert.match(result.html,/Unsubscribe from these emails/);
 assert.equal(result.text,body+'\n\nUnsubscribe: https://example.test/unsubscribe?token=abc&channel=email');
});
test('HTML and CRM values stay text, and unsafe URLs cannot become links or unsubscribe controls',()=>{
 const result=campaignEmail({subject:'<img src=x onerror=alert(1)>',senderName:'<script>brand()</script>',body:'Hello <script>bad()</script>\n\n" onclick="bad() https://user:password@example.test\n\njavascript:alert(1)',unsubscribeUrl:'javascript:alert(1)'});
 assert.ok(!result.html.includes('<script>'));assert.ok(!result.html.includes('<img'));assert.match(result.html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.match(result.html,/&quot; onclick=&quot;bad\(\)/);
 assert.ok(!result.html.includes('href="javascript:'));assert.ok(!result.html.includes('href="https://user:password'));assert.ok(!result.html.includes('Unsubscribe from these emails'));assert.ok(!result.text.includes('Unsubscribe:'));
});
test('Google and Outlook send personalized HTML MIME with plain text and unsubscribe headers',async()=>{
 for(const provider of ['google','microsoft']){
  let captured;
  const result=await sendProvider({channel:'email',provider,name:'Sender connection'},{email:'sender@example.test',accessToken:'synthetic'},'recipient@example.test',{subject:'Hello {{record.data.name}}',body:'Hi {{record.data.name}},\n\nVisit https://example.test/offers.\n\nThank you.'},{record:{data:{name:'<Asha & Team>'}},workspace:{name:'Example workspace'},unsubscribeUrl:'https://example.test/unsubscribe'},'email-html-test',async(url,options)=>{captured={url,options};return {body:{id:'synthetic-accepted'}};});
  const mime=Buffer.from(provider==='google'?JSON.parse(captured.options.body).raw:captured.options.body,provider==='google'?'base64url':'base64').toString('utf8');
  assert.match(mime,/Content-Type: multipart\/alternative/);assert.match(mime,/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);assert.match(mime,/Message-ID: <email-html-test@/);
  const html=alternative(mime,'html'),plain=alternative(mime,'plain');assert.match(html,/Example workspace/);assert.match(html,/Hi &lt;Asha &amp; Team&gt;,/);assert.match(html,/href="https:\/\/example.test\/offers"/);assert.match(html,/Unsubscribe from these emails/);
  assert.match(plain,/Hi <Asha & Team>,/);assert.match(plain,/Unsubscribe: https:\/\/example.test\/unsubscribe/);assert.ok(!html.includes('{{record.data.name}}'));assert.match(result.id,/email-html-test@/);
 }
});
test('SMTP uses the same formatted email content and keeps provider acceptance checks',async t=>{
 const original=nodemailer.createTransport;let sent,closed=false;
 nodemailer.createTransport=()=>({sendMail:async options=>{sent=options;return {accepted:['recipient@example.test']};},close:()=>{closed=true;}});t.after(()=>{nodemailer.createTransport=original;});
 await sendProvider({channel:'email',provider:'smtp'},{email:'sender@example.test',host:'8.8.8.8',port:587,user:'synthetic',password:'synthetic'},'recipient@example.test',{subject:'SMTP update',body:'Hello,\n\nYour update is ready.'},{workspace:{name:'SMTP workspace'},unsubscribeUrl:'https://example.test/unsubscribe'},'smtp-html-test');
 assert.match(sent.html,/SMTP workspace/);assert.match(sent.html,/<h1[^>]*>SMTP update<\/h1>/);assert.match(sent.html,/Unsubscribe from these emails/);assert.match(sent.text,/Your update is ready/);assert.equal(closed,true);
 nodemailer.createTransport=()=>({sendMail:async()=>({accepted:[]}),close:()=>{}});
 await assert.rejects(sendProvider({channel:'email',provider:'smtp'},{email:'sender@example.test',host:'8.8.8.8',port:587},'recipient@example.test',{subject:'Rejected',body:'Message'},{},'rejected-fixture'),error=>error.status===502);
});

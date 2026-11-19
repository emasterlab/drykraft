import test from 'node:test';
import assert from 'node:assert/strict';
import {providerHttpError} from '../server/http-node.mjs';

const calendar=new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
test('disabled Google Calendar API reports the exact setup action without exposing provider data',()=>{
 const error=providerHttpError(calendar,403,{error:{message:'Private provider text with secret-token',errors:[{reason:'accessNotConfigured'}],details:[{reason:'SERVICE_DISABLED',metadata:{service:'calendar-json.googleapis.com',consumer:'projects/821537693501',private:'secret-token'}}]}});
 assert.equal(error.status,502);assert.equal(error.providerReason,'SERVICE_DISABLED');assert.equal(error.providerStatus,403);
 assert.match(error.message,/Google Calendar API is disabled/);assert.match(error.message,/821537693501/);assert.match(error.message,/Enable/);
 assert.doesNotMatch(JSON.stringify(error)+error.message,/secret-token|Private provider text/);
});
test('missing Google permissions request reconnection instead of enabling an API',()=>{
 for(const body of [{error:{errors:[{reason:'insufficientPermissions'}]}},{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}}]){
  const error=providerHttpError(calendar,403,body);assert.match(error.message,/Connect the account again/);assert.doesNotMatch(error.message,/disabled/);
 }
});
test('Gmail setup errors and unknown HTTP failures retain safe messages',()=>{
 assert.match(providerHttpError(new URL('https://gmail.googleapis.com/gmail/v1/users/me/profile'),403,{error:{errors:[{reason:'accessNotConfigured'}]}}).message,/Gmail API is disabled/);
 for(const body of [null,'<html>secret-token</html>',{error:{message:'secret-token',details:[null,{}]}}]){
  assert.equal(providerHttpError(calendar,403,body).message,'The provider returned HTTP 403.');
 }
 assert.equal(providerHttpError(new URL('https://googleapis.com.example.test/calendar/v3/private'),403,{error:{errors:[{reason:'accessNotConfigured'}]}}).message,'The provider returned HTTP 403.');
 assert.equal(providerHttpError(calendar,401,{}).message,'The provider returned HTTP 401.');
});
test('WhatsApp token and permission failures show safe recovery actions',()=>{
 const url=new URL('https://graph.facebook.com/v23.0/123456/message_templates');
 const expired=providerHttpError(url,401,{error:{code:190,message:'private-token'}});
 assert.equal(expired.providerReason,'INVALID_ACCESS_TOKEN');assert.match(expired.message,/Replace credentials/);assert.doesNotMatch(expired.message,/private-token/);
 assert.match(providerHttpError(url,403,{error:{code:200}}).message,/required WhatsApp permissions/);
 assert.equal(providerHttpError(url,403,{error:{code:100,message:'private'}}).message,'The provider returned HTTP 403.');
});

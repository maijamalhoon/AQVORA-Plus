import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import app from '../server.mjs';

test('Vercel Express adapter serves UI, assets and a truthful database readiness endpoint',async t=>{
 const server=createServer(app);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port;
 const page=await fetch(url+'/');
 assert.equal(page.status,200);
 assert.match(page.headers.get('content-type')||'',/text\/html/);
 assert.match(await page.text(),/AQVORA PLUS|AQVORA Plus/i);

 const asset=await fetch(url+'/styles.css');
 assert.equal(asset.status,200);
 assert.match(asset.headers.get('content-type')||'',/text\/css/);

 const check=await fetch(url+'/api/demo-status');
 assert.equal(check.status,200);
 const readiness=await check.json();
 assert.equal(readiness.online,true);
 assert.equal(typeof readiness.workingDemo,'boolean');
 assert.ok(['not-configured','ready','needs-migrations','unavailable'].includes(readiness.database));
 if(!process.env.DATABASE_URL){
   assert.equal(readiness.workingDemo,false,'Static preview must not pretend a disconnected DMS works');
   const login=await fetch(url+'/api/auth/me');
   assert.equal(login.status,503);
 }else if(readiness.database==='ready'){
   const login=await fetch(url+'/api/auth/me');
   assert.equal(login.status,401,'Authenticated APIs must still require a session');
 }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';
import {SYSTEM_POSTED_CONTROL_CODES,blockedControlCodes} from '../server/ledger-controls.mjs';

test('Manual voucher policy keeps only source-aware financial control postings',()=>{
 assert.equal(SYSTEM_POSTED_CONTROL_CODES.length,5);
 assert.deepEqual(blockedControlCodes(['1000','2010101001','2010101001','1020301001']),
   ['1020301001','2010101001']);
 assert.deepEqual(blockedControlCodes(['101','200','500']),[]);
});

test('API blocks manual control-account vouchers and legacy drafts, preserves ordinary journals',{
 skip:!process.env.DATABASE_URL
},async t=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const suffix=randomBytes(6).toString('hex');
 const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',
   ['L'+suffix,'Ledger Control Audit QA'])).rows[0].id;
 const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',
   ['O'+suffix,'Other Company QA'])).rows[0].id;
 const dept=(await pool.query('INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3) RETURNING id',
   [company,'FINANCE','Finance'])).rows[0].id;
 await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
 const accounts=[
  ['1020301001','AR','ASSET'],['2010101001','AP','LIABILITY'],
  ['1020501001','Vehicle Inventory','ASSET'],['1020601001','Parts Inventory','ASSET'],
  ['2010201001','Sales Tax Liability','LIABILITY'],
  ['1020402001','Bank','ASSET'],['3010101001','Opening Equity','EQUITY'],
  ['5010301001','Operating Expense','EXPENSE']
 ];
 const accountIds=new Map();
 for(const [code,name,kind] of accounts){
   const row=await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4) RETURNING id',
     [company,code,name,kind]);
   accountIds.set(code,row.rows[0].id);
 }
 const password='Ledger-Control-Testing-Passphrase-2026';
 const email='fin-'+suffix+'@example.test';
 const actor=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
   [email,hashPassword(password)])).rows[0].id;
 await pool.query('INSERT INTO memberships(company_id,user_id,role,department_id) VALUES($1,$2,$3,$4)',
   [company,actor,'FINANCE',dept]);
 const app=createApp(pool);
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
 const origin='http://127.0.0.1:'+app.address().port;
 let session;
 async function call(path,{method='GET',body,tenant=company}={}){
   const headers={accept:'application/json'};
   if(method==='POST')headers['X-AQVORA-Request']='1';
   if(body!==undefined)headers['Content-Type']='application/json';
   if(session)headers.Cookie=session;
   if(tenant)headers['X-Company-ID']=tenant;
   const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 // Prior to authentication: malformed JSON shape must never crash the server.
 assert.equal((await call('/api/auth/login',{method:'POST',tenant:null,body:null})).status,400);
 assert.equal((await call('/api/auth/login',{method:'POST',tenant:null,body:[]})).status,400);
 const login=await call('/api/auth/login',{method:'POST',tenant:null,body:{email,password}});
 assert.equal(login.status,200);session=login.cookie;
 assert.ok(session?.startsWith('aqvora_session='));
 assert.equal((await call('/api/vouchers',{method:'POST',body:null})).status,400);
 assert.equal((await call('/api/vouchers',{method:'POST',body:{type:'JV'}})).status,400);
 assert.equal((await call('/api/vouchers',{tenant:other})).status,403);
 const accountList=await call('/api/accounts');
 assert.equal(accountList.status,200);
 for(const protectedCode of SYSTEM_POSTED_CONTROL_CODES){
   assert.equal(accountList.data.accounts.find(x=>x.code===protectedCode).manual_entry_allowed,false);
 }
 assert.equal(accountList.data.accounts.find(x=>x.code==='1020402001').manual_entry_allowed,true);
 const draft=(debitCode,creditCode='3010101001')=>({
   type:'JV',department:'FINANCE',date:'2026-11-20',narrative:'Finance QA manual posting',
   lines:[{accountCode:debitCode,debit:'1.00',credit:'0'},
     {accountCode:creditCode,debit:'0',credit:'1.00'}]
 });
 for(const protectedCode of SYSTEM_POSTED_CONTROL_CODES){
   const response=await call('/api/vouchers',{method:'POST',body:draft(protectedCode)});
   assert.equal(response.status,409,'Manual '+protectedCode+' rejected');
   assert.match(response.data.error,/source-controlled/i);
 }
 const good=await call('/api/vouchers',{method:'POST',body:draft('5010301001','1020402001')});
 assert.equal(good.status,201,JSON.stringify(good.data));
 const posted=await call('/api/vouchers/'+good.data.id+'/post',{method:'POST',body:{}});
 assert.equal(posted.status,200);
 // Simulate a historic draft created before the source-account restriction:
 // don't let the generic post endpoint bypass the current policy.
 const old=await pool.query(
  "INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,'JV','2026-11-20','Old uncontrolled draft',$3) RETURNING id",
  [company,dept,actor]);
 const oldId=old.rows[0].id;
 await pool.query(
  'INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,1,100,0),($1,$2,$4,2,0,100)',
  [company,oldId,accountIds.get('1020301001'),accountIds.get('3010101001')]);
 const forbiddenPost=await call('/api/vouchers/'+oldId+'/post',{method:'POST',body:{}});
 assert.equal(forbiddenPost.status,409,'Old drafts with AR control cannot post');
 const unchanged=await pool.query('SELECT status,voucher_number FROM vouchers WHERE company_id=$1 AND id=$2',[company,oldId]);
 assert.equal(unchanged.rows[0].status,'DRAFT');assert.equal(unchanged.rows[0].voucher_number,null);
 const trial=await call('/api/reports/trial-balance');
 const ar=trial.data.rows.find(x=>x.code==='1020301001');
 assert.equal(ar.balance_paisa,'0','No AR GL without an invoice/payment source');
 const allEntries=await pool.query(
  "SELECT count(*)::int AS posted FROM vouchers WHERE company_id=$1 AND status='POSTED'",[company]);
 assert.equal(allEntries.rows[0].posted,1,'Regular manual expense voucher still posts');
});

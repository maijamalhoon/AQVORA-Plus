import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Postgres: login, tenant isolation, voucher posting, reports and reversal',{
  skip:!process.env.DATABASE_URL
},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const suffix=randomBytes(4).toString('hex');
  const companyA=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['A'+suffix,'Test A'])).rows[0].id;
  const companyB=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['B'+suffix,'Test B'])).rows[0].id;
  const department=(await pool.query('INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3) RETURNING id',[companyA,'SERVICE','Service'])).rows[0].id;
  await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[companyA,'2026-11']);
  const cash='1000',capital='3000';
  await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[companyA,cash,'Cash','ASSET']);
  await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[companyA,capital,'Capital','EQUITY']);
  await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[companyB,'BONLY','Different tenant','ASSET']);
  const password='TestPassword123456!';
  const email='finance-'+suffix+'@example.test';
  const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hashPassword(password)])).rows[0].id;
  await pool.query('INSERT INTO memberships(company_id,user_id,role,department_id) VALUES($1,$2,$3,$4)',[companyA,user,'FINANCE',department]);
  const app=createApp(pool);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
  const base='http://127.0.0.1:'+app.address().port;
  async function request(path,{method='GET',body,token,company=companyA}={}){
    const headers={Accept:'application/json'};
    if(method!=='GET')headers['X-AQVORA-Request']='1';
    if(body!==undefined)headers['Content-Type']='application/json';
    if(token)headers.Cookie=token;
    if(company)headers['X-Company-ID']=company;
    const response=await fetch(base+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const unauthorized=await request('/api/vouchers');
  assert.equal(unauthorized.status,401);
  const login=await request('/api/auth/login',{method:'POST',body:{email,password},company:null});
  assert.equal(login.status,200);
  const token=login.cookie;
  assert.ok(token?.startsWith('aqvora_session='));
  const other=await request('/api/accounts',{token,company:companyB});
  assert.equal(other.status,403);
  const invalid=await request('/api/vouchers',{method:'POST',token,body:{
    type:'JV',department:'SERVICE',date:'2026-11-20',narrative:'Should be rejected',
    lines:[{accountCode:cash,debit:'100',credit:'0'},{accountCode:'BONLY',debit:'0',credit:'100'}]
  }});
  assert.equal(invalid.status,400);
  const draft=await request('/api/vouchers',{method:'POST',token,body:{
    type:'JV',department:'SERVICE',date:'2026-11-20',narrative:'Isolated test opening',
    lines:[{accountCode:cash,debit:'100.50',credit:'0'},{accountCode:capital,debit:'0',credit:'100.50'}]
  }});
  assert.equal(draft.status,201);
  const id=draft.data.id;
  const initial=await request('/api/reports/trial-balance',{token});
  assert.ok(initial.data.rows.every(r=>r.balance_paisa==='0'),'Draft must not hit trial balance');
  const posted=await request('/api/vouchers/'+id+'/post',{method:'POST',token,body:{}});
  assert.equal(posted.status,200);
  assert.equal(posted.data.number,'JV/2611000001');
  const twice=await request('/api/vouchers/'+id+'/post',{method:'POST',token,body:{}});
  assert.equal(twice.status,409);
  const trial=await request('/api/reports/trial-balance',{token});
  assert.equal(trial.data.rows.find(r=>r.code===cash).balance_paisa,'10050');
  assert.equal(trial.data.rows.find(r=>r.code===capital).balance_paisa,'-10050');
  const ledger=await request('/api/reports/ledger?account='+cash,{token});
  assert.equal(ledger.data.rows.length,1);
  assert.equal(ledger.data.rows[0].debit_paisa,'10050');
  await assert.rejects(pool.query('UPDATE voucher_lines SET debit_paisa=123 WHERE voucher_id=$1 AND debit_paisa>0',[id]),/Posted journal lines cannot be modified/);
  const reversal=await request('/api/vouchers/'+id+'/reverse',{method:'POST',token,body:{date:'2026-11-20',reason:'Reversal test'}});
  assert.equal(reversal.status,201);
  const zero=await request('/api/reports/trial-balance',{token});
  assert.ok(zero.data.rows.every(r=>r.balance_paisa==='0'));
  const reverseTwice=await request('/api/vouchers/'+id+'/reverse',{method:'POST',token,body:{date:'2026-11-20',reason:'Duplicate'}});
  assert.equal(reverseTwice.status,409);
  const oldMonth=await request('/api/vouchers',{method:'POST',token,body:{
    type:'JV',department:'SERVICE',date:'2026-10-20',narrative:'Locked period check',
    lines:[{accountCode:cash,debit:'1',credit:'0'},{accountCode:capital,debit:'0',credit:'1'}]
  }});
  assert.equal(oldMonth.status,201);
  const period=await request('/api/vouchers/'+oldMonth.data.id+'/post',{method:'POST',token,body:{}});
  assert.equal(period.status,409);
  const audit=await request('/api/audit',{token});
  assert.ok(audit.data.events.some(e=>e.action==='VOUCHER_REVERSED'));
  const logout=await request('/api/auth/logout',{method:'POST',token,body:{}});
  assert.equal(logout.status,200);
  assert.equal((await request('/api/auth/me',{token})).status,401);
});

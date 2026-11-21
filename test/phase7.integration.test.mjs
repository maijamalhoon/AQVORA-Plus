import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Phase 7: supplier refund requires independent approval, verified receipt and balanced stock/AP journals',{
  skip:!process.env.DATABASE_URL
},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const suffix=randomBytes(5).toString('hex');
  const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['G'+suffix,'Supplier Refund QA'])).rows[0].id;
  const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['H'+suffix,'Other company'])).rows[0].id;
  for(const d of ['SALES','SERVICE','PARTS','FINANCE'])
    await pool.query('INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',[company,d,d]);
  await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
  for(const [code,name,kind] of [
    ['2010101001','Accounts Payable','LIABILITY'],
    ['1020402001','Bank','ASSET'],
    ['1020601001','Parts Inventory','ASSET'],
    ['5010601001','Purchase Price Variance','EXPENSE']
  ])await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
  const pass='Strong-Approval-Refund-Test-Password-2026';
  const users={};
  for(const role of ['ADMIN','FINANCE','SALES','PARTS']){
    const email=role.toLowerCase()+'-'+suffix+'@example.test';
    const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hashPassword(pass)])).rows[0].id;
    await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,user,role]);
    users[role]={email};
  }
  const app=createApp(pool);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
  const base='http://127.0.0.1:'+app.address().port;
  async function request(path,{role='FINANCE',method='GET',body,tenant=company}={}){
    const headers={accept:'application/json'};
    if(method==='POST')headers['X-AQVORA-Request']='1';
    if(body!==undefined)headers['Content-Type']='application/json';
    if(users[role]?.cookie)headers.Cookie=users[role].cookie;
    if(tenant)headers['X-Company-ID']=tenant;
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const get=(path,role='FINANCE')=>request(path,{role});
  const post=(path,body,role='FINANCE')=>request(path,{method:'POST',body,role});
  for(const role of Object.keys(users)){
    const login=await request('/api/auth/login',{method:'POST',tenant:null,role,body:{email:users[role].email,password:pass}});
    assert.equal(login.status,200,role+' login');
    users[role].cookie=login.cookie;
  }
  assert.equal((await request('/api/phase7/supplier-refunds',{tenant:other})).status,403);
  assert.equal((await get('/api/phase7/supplier-refunds','PARTS')).status,403);
  assert.equal((await post('/api/phase7/refund-policy',{maxAmount:'500'},'FINANCE')).status,403);
  const vendor=await post('/api/finance4/suppliers',{name:'Approved Vendor'});
  assert.equal(vendor.status,201);
  const part=await post('/api/auto/parts',{sku:'SR-'+suffix,name:'Engine parts for refund QA'},'PARTS');
  assert.equal(part.status,201);
  const supplierId=vendor.data.id,partId=part.data.id;
  const buy1=await post('/api/finance4/purchases/parts',{
    supplierId,supplierInvoiceNo:'PAID-'+suffix,partId,quantity:5,unitCost:'100',
    date:'2026-11-20',dueDate:'2026-11-20'
  });
  assert.equal(buy1.status,201,JSON.stringify(buy1.data));
  const billId=buy1.data.id;
  const buy2=await post('/api/finance4/purchases/parts',{
    supplierId,supplierInvoiceNo:'UNPAID-'+suffix,partId,quantity:5,unitCost:'200',
    date:'2026-11-20',dueDate:'2026-11-20'
  });
  assert.equal(buy2.status,201);
  const payment=await post('/api/finance4/purchases/'+billId+'/payments',{
    amount:'500',date:'2026-11-20',clientKey:randomUUID()
  });
  assert.equal(payment.status,201,JSON.stringify(payment.data));
  const payload={billId,quantity:2,returnDate:'2026-11-20',
    reason:'Defective parts accepted by supplier; confirmed purchase invoice',
    clientKey:randomUUID()};
  const beforePolicy=await post('/api/phase7/supplier-refunds/requests',payload);
  assert.equal(beforePolicy.status,409,'Admin must configure a refund limit');
  assert.equal((await post('/api/phase7/refund-policy',{maxAmount:'100'},'ADMIN')).status,200);
  assert.equal((await post('/api/phase7/supplier-refunds/requests',payload)).status,409,'Request over company limit blocked');
  assert.equal((await post('/api/phase7/refund-policy',{maxAmount:'500'},'ADMIN')).status,200);
  assert.equal((await post('/api/phase7/supplier-refunds/requests',payload,'ADMIN')).status,403);
  const req=await post('/api/phase7/supplier-refunds/requests',payload);
  assert.equal(req.status,201,JSON.stringify(req.data));
  assert.equal(req.data.supplier_credit_paisa,'20000');
  const requestId=req.data.id;
  assert.equal((await post('/api/phase7/supplier-refunds/requests',payload)).status,409,'Idempotency key blocks duplicate request');
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/execute',{
    receivedDate:'2026-11-20',bankReference:'STMT-'+suffix
  })).status,409,'Cannot post unapproved bank refund');
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/decision',{
    decision:'APPROVED'
  })).status,403,'Finance cannot approve');
  const approved=await post('/api/phase7/supplier-refunds/'+requestId+'/decision',{
    decision:'APPROVED'
  },'ADMIN');
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/decision',{
    decision:'REJECTED'
  },'ADMIN')).status,409,'No revision of approved decision');
  assert.equal((await post('/api/phase7/refund-policy',{maxAmount:'150'},'ADMIN')).status,200);
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/execute',{
    receivedDate:'2026-11-20',bankReference:'STMT-'+suffix
  })).status,409,'Lowered limit blocks previously approved refund');
  assert.equal((await post('/api/phase7/refund-policy',{maxAmount:'500'},'ADMIN')).status,200);
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/execute',{
    receivedDate:'2026-11-20',bankReference:'STMT-'+suffix
  },'ADMIN')).status,403);
  const executed=await post('/api/phase7/supplier-refunds/'+requestId+'/execute',{
    receivedDate:'2026-11-20',bankReference:'STMT-'+suffix
  });
  assert.equal(executed.status,201,JSON.stringify(executed.data));
  assert.equal(executed.data.refunded_paisa,'20000');
  assert.match(executed.data.returnReference,/^PR\/2611000001$/);
  assert.equal((await post('/api/phase7/supplier-refunds/'+requestId+'/execute',{
    receivedDate:'2026-11-20',bankReference:'STMT-'+suffix
  })).status,409,'Duplicate execution rejected');

  const parts=await get('/api/auto/parts','PARTS');
  const current=parts.data.parts.find(p=>p.id===partId);
  assert.equal(current.stock_qty,8);
  assert.equal(current.inventory_value_paisa,'120000','Weighted-average value drops by PKR 300');
  const bills=(await get('/api/finance4/purchases')).data.purchases;
  const original=bills.find(b=>b.id===billId);
  assert.equal(original.refunded_paisa,'20000');
  assert.equal(original.credited_paisa,'20000');
  assert.equal(original.outstanding_paisa,'0','Supplier AP clears on confirmed refund');
  assert.equal(bills.find(b=>b.id===buy2.data.id).outstanding_paisa,'100000');
  const aging=(await get('/api/phase5/reports/ap-aging')).data.rows;
  assert.ok(!aging.some(x=>x.reference===original.reference));
  const trial=await get('/api/reports/trial-balance');
  const balances=new Map(trial.data.rows.map(r=>[r.code,r.balance_paisa]));
  assert.equal(balances.get('2010101001'),'-100000','Only unpaid supplier bill remains in AP');
  assert.equal(balances.get('1020601001'),'120000');
  assert.equal(balances.get('1020402001'),'-30000','Bank net of supplier payment and refund');
  assert.equal(balances.get('5010601001'),'10000','Cost variance separately posted as expense');
  const reconciliation=await get('/api/reports/reconciliation');
  assert.equal(reconciliation.data.reconciled,true,JSON.stringify(reconciliation.data));
  assert.ok(reconciliation.data.checks.every(c=>c.difference_paisa==='0'));
  const audit=await get('/api/phase7/supplier-refunds/audit');
  assert.equal(audit.status,200);
  assert.equal(audit.data.reconciled,true,JSON.stringify(audit.data));
  assert.equal(audit.data.executed,1);
  assert.equal(audit.data.received_paisa,'20000');
  const receipt=await pool.query('SELECT id,voucher_id FROM supplier_refund_receipts WHERE company_id=$1',[company]);
  assert.equal(receipt.rowCount,1);
  await assert.rejects(pool.query('DELETE FROM supplier_refund_receipts WHERE id=$1',[receipt.rows[0].id]),/immutable/);
  assert.equal((await post('/api/vouchers/'+receipt.rows[0].voucher_id+'/reverse',{
    date:'2026-11-20',reason:'Must use source-aware workflow'
  })).status,409);
});

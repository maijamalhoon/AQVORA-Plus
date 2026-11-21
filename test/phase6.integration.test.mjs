import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Phase 6: independently approved paid vehicle refund atomically reconciles cash, tax, AR and GL',{
 skip:!process.env.DATABASE_URL
},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const suffix=randomBytes(5).toString('hex');
  const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['R'+suffix,'Refund QA'])).rows[0].id;
  const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['Z'+suffix,'Other tenant'])).rows[0].id;
  for(const d of ['SALES','SERVICE','PARTS','FINANCE'])await pool.query(
    'INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',[company,d,d]);
  await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
  const accounts=[
    ['1020301001','AR','ASSET'],['1020402001','Bank','ASSET'],
    ['1020501001','Vehicle Stock','ASSET'],['1020601001','Parts Stock','ASSET'],
    ['2010101001','AP','LIABILITY'],['2010201001','Sales Tax','LIABILITY'],
    ['4010301001','Sales Income','INCOME'],['5010401001','Vehicle COGS','EXPENSE']
  ];
  for(const [code,name,kind] of accounts)await pool.query(
    'INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
  const password='QA-Password-For-Two-Person-Refunds';
  const members={};
  for(const role of ['ADMIN','FINANCE','SALES']){
    const email=role.toLowerCase()+'-'+suffix+'@example.test';
    const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
      [email,hashPassword(password)])).rows[0].id;
    await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,user,role]);
    members[role]={email,id:user};
  }
  const app=createApp(pool);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
  const base='http://127.0.0.1:'+app.address().port;
  async function request(path,{role='FINANCE',method='GET',body,tenant=company}={}){
    const headers={accept:'application/json'};
    if(method==='POST')headers['X-AQVORA-Request']='1';
    if(body!==undefined)headers['Content-Type']='application/json';
    if(members[role]?.cookie)headers.Cookie=members[role].cookie;
    if(tenant)headers['X-Company-ID']=tenant;
    const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const get=(path,role='FINANCE')=>request(path,{role});
  const post=(path,body,role='FINANCE')=>request(path,{role,method:'POST',body});
  for(const role of Object.keys(members)){
    const res=await request('/api/auth/login',{role,method:'POST',tenant:null,
      body:{email:members[role].email,password}});
    assert.equal(res.status,200,role+' session');
    members[role].cookie=res.cookie;
  }
  assert.equal((await request('/api/phase6/refunds',{tenant:other})).status,403);
  assert.equal((await get('/api/phase6/refunds','SALES')).status,403);

  const tax=await post('/api/phase5/tax-codes',{code:'QA10',name:'QA example rate',rateBps:1000},'ADMIN');
  assert.equal(tax.status,201);
  const supplier=await post('/api/finance4/suppliers',{name:'Supplier Refund QA'});
  assert.equal(supplier.status,201);
  const stock=await post('/api/finance4/purchases/vehicle',{
    supplierId:supplier.data.id,supplierInvoiceNo:'R-'+suffix,chassis:'NEW-'+suffix,
    variant:'Test Premium Sedan',listPrice:'4500000',cost:'3000000',
    date:'2026-11-20',dueDate:'2026-11-20'
  });
  assert.equal(stock.status,201,JSON.stringify(stock.data));
  const customer=await post('/api/auto/customers',{name:'Vehicle Refund Customer'},'SALES');
  assert.equal(customer.status,201);
  const booked=await post('/api/auto/sales/bookings',{
    customerId:customer.data.id,vehicleId:stock.data.vehicleId,price:'4500000'
  },'SALES');
  assert.equal(booked.status,201);
  const sale=await post('/api/finance4/sales-invoices',{
    bookingId:booked.data.id,date:'2026-11-20',dueDate:'2026-11-20',taxCode:'QA10'
  });
  assert.equal(sale.status,201,JSON.stringify(sale.data));
  const invoiceId=sale.data.id;
  const receipt=await post('/api/finance4/sales-invoices/'+invoiceId+'/payments',{
    amount:'4950000',date:'2026-11-20',clientKey:randomUUID()
  });
  assert.equal(receipt.status,201);
  let control=await get('/api/reports/reconciliation');
  assert.equal(control.data.reconciled,true,JSON.stringify(control.data));

  const adjustment={
    invoiceId,netAmount:'100000',date:'2026-11-20',
    reason:'Documented customer price correction agreed after full payment',
    clientKey:randomUUID()
  };
  assert.equal((await post('/api/phase6/refunds/requests',adjustment,'ADMIN')).status,403);
  const pending=await post('/api/phase6/refunds/requests',adjustment);
  assert.equal(pending.status,201,JSON.stringify(pending.data));
  assert.equal(pending.data.refund_amount_paisa,'11000000');
  const reqId=pending.data.id;
  assert.equal((await post('/api/phase6/refunds/requests',adjustment)).status,409,'Duplicate refund request key rejected');
  assert.equal((await post('/api/phase6/refunds/requests',{
    ...adjustment,clientKey:randomUUID(),date:'2026-10-20'
  })).status,409,'No refund before invoice date');
  assert.equal((await post('/api/phase6/refunds/'+reqId+'/decision',{decision:'APPROVED'})).status,403);
  assert.equal((await post('/api/phase6/refunds/'+reqId+'/execute',{})).status,409,'Unapproved refund cannot execute');
  assert.equal((await post('/api/phase6/refunds/'+reqId+'/decision',{decision:'APPROVED'},'SALES')).status,403);

  const approved=await post('/api/phase6/refunds/'+reqId+'/decision',{decision:'APPROVED'},'ADMIN');
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.status,'APPROVED');
  assert.equal((await post('/api/phase6/refunds/'+reqId+'/decision',{decision:'REJECTED'},'ADMIN')).status,409);

  const posted=await post('/api/phase6/refunds/'+reqId+'/execute',{});
  assert.equal(posted.status,201,JSON.stringify(posted.data));
  assert.match(posted.data.creditNote,/^CN\/2611000001$/);
  assert.equal(posted.data.refund_paisa,'11000000');
  assert.equal((await post('/api/phase6/refunds/'+reqId+'/execute',{})).status,409,'Never post an approved refund twice');

  const invoice=(await get('/api/finance4/sales-invoices')).data.invoices.find(x=>x.id===invoiceId);
  assert.equal(invoice.paid_paisa,'484000000','Paid field is NET cash receipts after approved refund');
  assert.equal(invoice.credited_net_paisa,'10000000');
  assert.equal(invoice.credited_tax_paisa,'1000000');
  assert.equal(invoice.outstanding_paisa,'0','AR must remain zero after refund + credit');
  const trial=await get('/api/reports/trial-balance');
  const balances=new Map(trial.data.rows.map(r=>[r.code,r.balance_paisa]));
  assert.equal(balances.get('1020301001'),'0','Posted AR must reconcile to invoice');
  assert.equal(balances.get('1020402001'),'484000000','Bank balance reflects cash out');
  assert.equal(balances.get('2010201001'),'-44000000','Tax liability reflects reversal');
  assert.equal(balances.get('4010301001'),'-440000000','Sales revenue reflects refund price adjustment');
  const audit=await get('/api/phase6/refunds/audit');
  assert.equal(audit.status,200);
  assert.equal(audit.data.reconciled,true,JSON.stringify(audit.data));
  assert.equal(audit.data.executed,1);
  assert.equal(audit.data.paid_out_paisa,'11000000');
  control=await get('/api/reports/reconciliation');
  assert.equal(control.data.reconciled,true,JSON.stringify(control.data));
  const note=await get('/api/phase5/credit-notes');
  assert.equal(note.data.notes.length,1);
  assert.equal(note.data.notes[0].tax_paisa,'1000000');
  const refundRow=await pool.query(
    'SELECT id,voucher_id FROM vehicle_refund_disbursements WHERE company_id=$1',[company]);
  assert.equal(refundRow.rowCount,1);
  await assert.rejects(pool.query('DELETE FROM vehicle_refund_disbursements WHERE id=$1',[refundRow.rows[0].id]),/immutable/);
  assert.equal((await post('/api/vouchers/'+refundRow.rows[0].voucher_id+'/reverse',{
    date:'2026-11-20',reason:'Should not reverse source-linked refund'
  })).status,409);

  const rejectedRequest=await post('/api/phase6/refunds/requests',{
    invoiceId,netAmount:'1000',date:'2026-11-20',
    reason:'Second documented request for reject testing',clientKey:randomUUID()
  });
  assert.equal(rejectedRequest.status,201);
  const rejected=await post('/api/phase6/refunds/'+rejectedRequest.data.id+'/decision',{decision:'REJECTED'},'ADMIN');
  assert.equal(rejected.status,200);
  assert.equal((await post('/api/phase6/refunds/'+rejectedRequest.data.id+'/execute',{})).status,409);
  const list=await get('/api/phase6/refunds');
  assert.ok(list.data.requests.some(r=>r.id===reqId&&r.status==='EXECUTED'));
  assert.ok(list.data.requests.some(r=>r.id===rejectedRequest.data.id&&r.status==='REJECTED'));
});

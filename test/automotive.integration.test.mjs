import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Dealership workflows: booking, job card, parts, invoice, partial payments and aging',{
  skip:!process.env.DATABASE_URL
},async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const suffix=randomBytes(5).toString('hex'),pass='QA-Only-Passphrase-123456!';
  const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['C'+suffix,'Automotive Testing'])).rows[0].id;
  const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['D'+suffix,'Other Organization'])).rows[0].id;
  for(const d of ['SALES','SERVICE','PARTS','FINANCE'])await pool.query(
    'INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',[company,d,d]);
  await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
  const seed=[
    ['1020301001','AR','ASSET'],['1020402001','BANK','ASSET'],['4010101001','SERVICE REVENUE','INCOME']
  ];
  for(const [code,name,kind] of seed)await pool.query(
    'INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
  const people={};
  for(const role of ['SALES','SERVICE','PARTS','FINANCE']){
    const email=role.toLowerCase()+'-'+suffix+'@example.test';
    const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hashPassword(pass)])).rows[0].id;
    await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,user,role]);
    people[role]={email};
  }
  const app=createApp(pool);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
  const origin='http://127.0.0.1:'+app.address().port;
  async function request(path,{method='GET',body,token,tenant=company}={}){
    const headers={'Accept':'application/json'};
    if(method!=='GET')headers['X-AQVORA-Request']='1';
    if(body!==undefined)headers['Content-Type']='application/json';
    if(token)headers.Cookie=token;
    if(tenant)headers['X-Company-ID']=tenant;
    const response=await fetch(origin+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  for(const role of Object.keys(people)){
    const response=await request('/api/auth/login',{method:'POST',tenant:null,body:{email:people[role].email,password:pass}});
    assert.equal(response.status,200,role+' login');
    people[role].cookie=response.cookie;
  }
  const get=(role,path)=>request(path,{token:people[role].cookie});
  const post=(role,path,body)=>request(path,{method:'POST',token:people[role].cookie,body});
  assert.equal((await request('/api/auto/customers')).status,401);
  assert.equal((await request('/api/auto/customers',{token:people.SALES.cookie,tenant:other})).status,403);
  assert.equal((await post('SALES','/api/auto/service/invoices',{jobId:'none'})).status,403);
  assert.equal((await post('SERVICE','/api/auto/parts',{sku:'NO',name:'Forbidden'})).status,403);

  // Customer can be used in both Sales and Service within the same company.
  const customer=await post('SALES','/api/auto/customers',{name:'Demo Customer',phone:'03001234567'});
  assert.equal(customer.status,201);const customerId=customer.data.id;
  const vehicle=await post('SALES','/api/auto/vehicle-stock',{chassis:'VIN-'+suffix,variant:'Demo Sedan',color:'White',price:'4,500,000'});
  assert.equal(vehicle.status,201);const stockId=vehicle.data.id;
  const bookingBody={customerId,vehicleId:stockId,price:'4,350,000'};
  const booked=await post('SALES','/api/auto/sales/bookings',bookingBody);
  assert.equal(booked.status,201);assert.match(booked.data.reference,/^SO\/\d{10}$/);
  assert.equal((await post('SALES','/api/auto/sales/bookings',bookingBody)).status,409);
  const bookedStock=await get('SALES','/api/auto/vehicle-stock');
  assert.equal(bookedStock.data.vehicles.find(x=>x.id===stockId).status,'RESERVED');
  assert.equal((await post('SALES','/api/auto/sales/bookings/'+booked.data.id+'/cancel',{})).status,200);
  assert.equal((await post('SALES','/api/auto/sales/bookings/'+booked.data.id+'/cancel',{})).status,409);
  assert.equal((await get('SALES','/api/auto/vehicle-stock')).data.vehicles.find(x=>x.id===stockId).status,'IN_STOCK');

  const owned=await post('SERVICE','/api/auto/customer-vehicles',{
    customerId,registration:'ABC-123',chassis:'OWN-'+suffix,model:'Demo Corolla'
  });
  assert.equal(owned.status,201);
  const job=await post('SERVICE','/api/auto/service/jobs',{vehicleId:owned.data.id,complaint:'Engine inspection'});
  assert.equal(job.status,201);assert.match(job.data.reference,/^JC\/\d{10}$/);
  const jobId=job.data.id;
  assert.equal((await post('SERVICE','/api/auto/service/jobs/'+jobId+'/status',{status:'COMPLETED'})).status,409);
  assert.equal((await post('SERVICE','/api/auto/service/jobs/'+jobId+'/status',{status:'IN_PROGRESS'})).status,200);
  assert.equal((await post('FINANCE','/api/auto/service/invoices',{
    jobId,laborAmount:'1000.00',date:'2026-11-20',dueDate:'2026-11-20'
  })).status,409,'Cannot invoice incomplete job');

  const part=await post('PARTS','/api/auto/parts',{sku:'OIL-FILTER-01',name:'Engine oil filter'});
  assert.equal(part.status,201);const partId=part.data.id;
  assert.equal((await post('PARTS','/api/auto/stock-movements',{
    partId,direction:'ISSUE',quantity:1,reference:'ISS-01',jobId
  })).status,409,'Cannot issue from zero stock');
  const receipt={partId,direction:'RECEIPT',quantity:5,reference:'GRN-001',unitCost:'1200'};
  assert.equal((await post('PARTS','/api/auto/stock-movements',receipt)).status,201);
  assert.equal((await post('PARTS','/api/auto/stock-movements',receipt)).status,409,'Duplicate GRN should not inflate stock');
  assert.equal((await post('PARTS','/api/auto/stock-movements',{
    partId,direction:'ISSUE',quantity:3,reference:'ISS-001',jobId
  })).status,201);
  assert.equal((await get('PARTS','/api/auto/parts')).data.parts.find(x=>x.id===partId).stock_qty,2);
  const movement=await pool.query('SELECT id FROM stock_movements WHERE company_id=$1 LIMIT 1',[company]);
  await assert.rejects(pool.query('DELETE FROM stock_movements WHERE id=$1',[movement.rows[0].id]),/immutable/);
  assert.equal((await post('SERVICE','/api/auto/service/jobs/'+jobId+'/status',{status:'COMPLETED'})).status,200);
  assert.equal((await post('PARTS','/api/auto/stock-movements',{
    partId,direction:'ISSUE',quantity:1,reference:'ISS-LATE',jobId
  })).status,409,'No stock issue after job completion');

  const invoice=await post('FINANCE','/api/auto/service/invoices',{
    jobId,laborAmount:'1,000.00',date:'2026-11-20',dueDate:'2026-11-20'
  });
  assert.equal(invoice.status,201);assert.match(invoice.data.reference,/^SI\/2611000001$/);
  assert.equal((await post('FINANCE','/api/auto/service/invoices',{
    jobId,laborAmount:'1000',date:'2026-11-20',dueDate:'2026-11-20'
  })).status,409,'Cannot invoice a job twice');

  let trial=await get('FINANCE','/api/reports/trial-balance');
  assert.equal(trial.data.rows.find(x=>x.code==='1020301001').balance_paisa,'100000');
  assert.equal(trial.data.rows.find(x=>x.code==='4010101001').balance_paisa,'-100000');
  const invId=invoice.data.id;
  const invoiceList=await get('FINANCE','/api/auto/service/invoices');
  assert.equal(invoiceList.data.invoices.find(x=>x.id===invId).balance_paisa,'100000');
  const partial=await post('FINANCE','/api/auto/service/invoices/'+invId+'/payments',{amount:'400',date:'2026-11-20'});
  assert.equal(partial.status,201);
  const aging=await get('FINANCE','/api/reports/ar-aging');
  assert.equal(aging.data.rows.find(x=>x.reference===invoice.data.reference).outstanding_paisa,'60000');
  assert.equal((await post('FINANCE','/api/auto/service/invoices/'+invId+'/payments',{amount:'601',date:'2026-11-20'})).status,409);
  assert.equal((await post('FINANCE','/api/auto/service/invoices/'+invId+'/payments',{amount:'600',date:'2026-11-20'})).status,201);
  assert.ok(!(await get('FINANCE','/api/reports/ar-aging')).data.rows.some(x=>x.reference===invoice.data.reference));
  trial=await get('FINANCE','/api/reports/trial-balance');
  assert.equal(trial.data.rows.find(x=>x.code==='1020301001').balance_paisa,'0');
  assert.equal(trial.data.rows.find(x=>x.code==='1020402001').balance_paisa,'100000');
  const source=await pool.query('SELECT voucher_id FROM service_invoices WHERE id=$1',[invId]);
  assert.equal((await post('FINANCE','/api/vouchers/'+source.rows[0].voucher_id+'/reverse',{date:'2026-11-20',reason:'Not allowed'})).status,409);
});

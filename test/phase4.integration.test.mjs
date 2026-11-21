import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Phase 4: accounted procurement, vehicle sale, parts COGS and reconciled control accounts',{
 skip:!process.env.DATABASE_URL
},async t=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const suf=randomBytes(5).toString('hex'),companyCode='E'+suf,pass='QA-dev-password-123456!';
 const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',[companyCode,'Accounting QA'])).rows[0].id;
 const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['F'+suf,'Other Company'])).rows[0].id;
 for(const d of ['SALES','SERVICE','PARTS','FINANCE'])
   await pool.query('INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',[company,d,d]);
 await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
 for(const [code,name,kind] of [
   ['1020301001','AR','ASSET'],['2010101001','AP','LIABILITY'],
   ['1020402001','BANK','ASSET'],['1020501001','VEHICLE INVENTORY','ASSET'],
   ['1020601001','PARTS INVENTORY','ASSET'],['4010301001','VEHICLE REVENUE','INCOME'],
   ['5010401001','VEHICLE COGS','EXPENSE'],['5010501001','PARTS COGS','EXPENSE']
 ])await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
 const identities={};
 for(const role of ['SALES','PARTS','FINANCE','SERVICE']){
   const email=role.toLowerCase()+'-'+suf+'@example.test';
   const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hashPassword(pass)])).rows[0].id;
   await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,user,role]);
   identities[role]={email};
 }
 const app=createApp(pool);
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
 const url='http://127.0.0.1:'+app.address().port;
 async function req(path,{role='FINANCE',method='GET',body,tenant=company}={}){
  const headers={'accept':'application/json'};
  if(method!=='GET')headers['x-aqvora-request']='1';
  if(body!==undefined)headers['content-type']='application/json';
  if(identities[role]?.cookie)headers.cookie=identities[role].cookie;
  if(tenant)headers['x-company-id']=tenant;
  const response=await fetch(url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 const post=(path,body,role='FINANCE')=>req(path,{role,method:'POST',body});
 const get=(path,role='FINANCE')=>req(path,{role});
 for(const role of Object.keys(identities)){
  const resp=await req('/api/auth/login',{role,method:'POST',tenant:null,body:{email:identities[role].email,password:pass}});
  assert.equal(resp.status,200,role+' login');identities[role].cookie=resp.cookie;
 }
 assert.equal((await req('/api/finance4/suppliers',{role:'FINANCE',tenant:other})).status,403);
 assert.equal((await post('/api/finance4/suppliers',{name:'Blocked'},'SALES')).status,403);
 const supplier=await post('/api/finance4/suppliers',{name:'Vendor Test'});
 assert.equal(supplier.status,201);
 const supplierId=supplier.data.id;
 const vehicleBill={
  supplierId,supplierInvoiceNo:'VB-'+suf,chassis:'CHS-'+suf,variant:'Sedan Test',
  color:'Silver',listPrice:'4,500,000',cost:'3,000,000',date:'2026-11-20',dueDate:'2026-11-20'
 };
 const bought=await post('/api/finance4/purchases/vehicle',vehicleBill);
 assert.equal(bought.status,201,JSON.stringify(bought.data));
 assert.equal((await post('/api/finance4/purchases/vehicle',vehicleBill)).status,409,'Duplicate supplier invoice cannot capitalize twice');
 let report=await get('/api/reports/reconciliation');
 assert.equal(report.status,200);
 assert.equal(report.data.reconciled,true,JSON.stringify(report.data));
 const customer=await post('/api/auto/customers',{name:'Test Customer'},'SALES');
 assert.equal(customer.status,201);
 const booking=await post('/api/auto/sales/bookings',{
    customerId:customer.data.id,vehicleId:bought.data.vehicleId,price:'4,500,000'
 },'SALES');
 assert.equal(booking.status,201);
 const sale=await post('/api/finance4/sales-invoices',{bookingId:booking.data.id,date:'2026-11-20',dueDate:'2026-11-20'});
 assert.equal(sale.status,201,JSON.stringify(sale.data));
 assert.match(sale.data.reference,/^VI\/2611000001$/);
 assert.equal((await post('/api/finance4/sales-invoices',{bookingId:booking.data.id,date:'2026-11-20',dueDate:'2026-11-20'})).status,409);
 const stock=await get('/api/auto/vehicle-stock','SALES');
 assert.equal(stock.data.vehicles.find(v=>v.id===bought.data.vehicleId).status,'SOLD');
 assert.equal((await post('/api/auto/sales/bookings/'+booking.data.id+'/cancel',{},'SALES')).status,409);

 const serviceVehicle=await post('/api/auto/customer-vehicles',{
    customerId:customer.data.id,registration:'XY-123',chassis:'USED-'+suf,model:'Corolla 1.8'
 },'SERVICE');
 assert.equal(serviceVehicle.status,201);
 const job=await post('/api/auto/service/jobs',{vehicleId:serviceVehicle.data.id,complaint:'Replace parts'},'SERVICE');
 assert.equal(job.status,201);
 const part=await post('/api/auto/parts',{sku:'SKU-'+suf,name:'Accounting test part'},'PARTS');
 assert.equal(part.status,201);
 const partId=part.data.id,jobId=job.data.id;
 const p1=await post('/api/finance4/purchases/parts',{
  supplierId,supplierInvoiceNo:'PB1-'+suf,partId,quantity:5,unitCost:'100',
  date:'2026-11-20',dueDate:'2026-11-20'
 });
 assert.equal(p1.status,201,JSON.stringify(p1.data));
 assert.equal((await post('/api/auto/stock-movements',{
   partId,direction:'ISSUE',quantity:1,reference:'LEGACY-BLOCK',jobId
 },'PARTS')).status,409);
 const issue1=await post('/api/finance4/parts/issue',{
  partId,jobId,quantity:2,reference:'ISS1-'+suf,date:'2026-11-20'
 });
 assert.equal(issue1.status,201);assert.equal(issue1.data.cost_paisa,'20000');
 const p2=await post('/api/finance4/purchases/parts',{
  supplierId,supplierInvoiceNo:'PB2-'+suf,partId,quantity:3,unitCost:'200',
  date:'2026-11-20',dueDate:'2026-11-20'
 });
 assert.equal(p2.status,201,JSON.stringify(p2.data));
 const issue2=await post('/api/finance4/parts/issue',{
  partId,jobId,quantity:4,reference:'ISS2-'+suf,date:'2026-11-20'
 });
 assert.equal(issue2.status,201);assert.equal(issue2.data.cost_paisa,'60000');
 const partState=(await get('/api/auto/parts','PARTS')).data.parts.find(x=>x.id===partId);
 assert.equal(partState.stock_qty,2);
 assert.equal(partState.inventory_value_paisa,'30000');
 assert.equal(partState.valuation_mode,'POSTED');
 // GL reconciliation must match current invoice and inventory balances.
 report=await get('/api/reports/reconciliation');
 assert.equal(report.data.reconciled,true,JSON.stringify(report.data));
 assert.ok(report.data.checks.every(c=>c.difference_paisa==='0'));
 // Partial customer collection, idempotency guard and overpayment rejection.
 const customerKey=randomUUID();
 const c1=await post('/api/finance4/sales-invoices/'+sale.data.id+'/payments',
  {amount:'1,000,000',date:'2026-11-20',clientKey:customerKey});
 assert.equal(c1.status,201,JSON.stringify(c1.data));
 assert.equal((await post('/api/finance4/sales-invoices/'+sale.data.id+'/payments',
  {amount:'1,000,000',date:'2026-11-20',clientKey:customerKey})).status,409,'Duplicate payment token rejected');
 assert.equal((await post('/api/finance4/sales-invoices/'+sale.data.id+'/payments',
  {amount:'3,500,001',date:'2026-11-20',clientKey:randomUUID()})).status,409);
 // Partial supplier settlement with AP control posting.
 const supplierKey=randomUUID();
 const pay=await post('/api/finance4/purchases/'+bought.data.id+'/payments',
  {amount:'500,000',date:'2026-11-20',clientKey:supplierKey});
 assert.equal(pay.status,201);
 assert.equal((await post('/api/finance4/purchases/'+bought.data.id+'/payments',
  {amount:'500,000',date:'2026-11-20',clientKey:supplierKey})).status,409);
 report=await get('/api/reports/reconciliation');
 assert.equal(report.data.reconciled,true,JSON.stringify(report.data));

 const purchases=(await get('/api/finance4/purchases')).data.purchases;
 assert.equal(purchases.find(p=>p.id===bought.data.id).outstanding_paisa,'250000000');
 const saleRow=(await get('/api/finance4/sales-invoices')).data.invoices.find(x=>x.id===sale.data.id);
 assert.equal(saleRow.outstanding_paisa,'350000000');

 const source=await pool.query('SELECT voucher_id FROM purchase_bills WHERE company_id=$1 AND id=$2',[company,bought.data.id]);
 assert.equal((await post('/api/vouchers/'+source.rows[0].voucher_id+'/reverse',
    {date:'2026-11-20',reason:'Blocked reversal'})).status,409);
 const payRow=await pool.query('SELECT id FROM supplier_payments WHERE company_id=$1 LIMIT 1',[company]);
 await assert.rejects(pool.query('DELETE FROM supplier_payments WHERE id=$1',[payRow.rows[0].id]),/immutable/);
 const historicalSale=(await get('/api/finance4/sales-invoices')).data.invoices.length;
 assert.equal(historicalSale,1);
 const legacy=await post('/api/auto/vehicle-stock',{chassis:'OLD-'+suf,variant:'Old import',price:'4,000,000'},'SALES');
 assert.equal(legacy.status,201);
 report=await get('/api/reports/reconciliation');
 assert.equal(report.data.unresolved_legacy.vehicles,1);
 assert.equal(report.data.reconciled,false);
});

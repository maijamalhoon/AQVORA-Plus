import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Phase 5: tax snapshot, credit, vendor return and settled vehicle handover',{
 skip:!process.env.DATABASE_URL
},async t=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const tag=randomBytes(5).toString('hex'),companyCode='T'+tag,password='Demo-Passphrase-For-QA-555';
 const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',[companyCode,'Phase Five QA'])).rows[0].id;
 const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['X'+tag,'Other Company'])).rows[0].id;
 for(const dep of ['SALES','SERVICE','PARTS','FINANCE'])await pool.query(
   'INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',[company,dep,dep]);
 await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
 for(const [code,name,kind] of [
  ['1020301001','Accounts Receivable','ASSET'],
  ['1020402001','Bank','ASSET'],
  ['1020501001','Vehicle Inventory','ASSET'],
  ['1020601001','Parts Inventory','ASSET'],
  ['2010101001','Accounts Payable','LIABILITY'],
  ['2010201001','Sales Tax Control','LIABILITY'],
  ['4010301001','Vehicle Revenue','INCOME'],
  ['5010401001','Vehicle COGS','EXPENSE'],
  ['5010501001','Parts Consumption','EXPENSE'],
  ['5010601001','Purchase Price Variance','EXPENSE']
 ])await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
 const people={};
 for(const role of ['ADMIN','FINANCE','SALES','SERVICE','PARTS']){
  const email=role.toLowerCase()+'-'+tag+'@example.test';
  const user=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hashPassword(password)])).rows[0].id;
  await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,user,role]);
  people[role]={email};
 }
 const app=createApp(pool);
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
 const base='http://127.0.0.1:'+app.address().port;
 async function call(path,{role='FINANCE',method='GET',body,tenant=company}={}){
  const headers={accept:'application/json'};
  if(method==='POST')headers['X-AQVORA-Request']='1';
  if(body!==undefined)headers['Content-Type']='application/json';
  if(people[role]?.token)headers.Cookie=people[role].token;
  if(tenant)headers['X-Company-ID']=tenant;
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json(),token:response.headers.get('set-cookie')?.split(';')[0]};
 }
 const get=(p,role='FINANCE')=>call(p,{role});
 const post=(p,b,role='FINANCE')=>call(p,{method:'POST',body:b,role});
 for(const role of Object.keys(people)){
  const r=await call('/api/auth/login',{role,method:'POST',tenant:null,body:{email:people[role].email,password}});
  assert.equal(r.status,200,role+' login');people[role].token=r.token;
 }
 assert.equal((await call('/api/phase5/tax-codes',{tenant:other})).status,403,'Tax codes cannot leak across companies');
 assert.equal((await post('/api/phase5/tax-codes',{code:'TAX15',name:'15% test',rateBps:1500},'FINANCE')).status,403);
 const tax=await post('/api/phase5/tax-codes',{code:'QA15',name:'Test rate 15%',rateBps:1500},'ADMIN');
 assert.equal(tax.status,201,JSON.stringify(tax.body));
 assert.equal((await post('/api/phase5/tax-codes',{code:'QA15',name:'Duplicate',rateBps:900},'ADMIN')).status,409);
 const vendor=await post('/api/finance4/suppliers',{name:'Phase Five Vendor'});
 assert.equal(vendor.status,201);
 const supplierId=vendor.body.id;
 const part=await post('/api/auto/parts',{sku:'QA-'+tag,name:'Timing belt'},'PARTS');
 assert.equal(part.status,201);
 const partId=part.body.id;
 const p1=await post('/api/finance4/purchases/parts',{
  supplierId,supplierInvoiceNo:'BILL1-'+tag,partId,quantity:5,unitCost:'100.00',
  date:'2026-11-20',dueDate:'2026-11-20'
 });
 assert.equal(p1.status,201,JSON.stringify(p1.body));
 const p2=await post('/api/finance4/purchases/parts',{
  supplierId,supplierInvoiceNo:'BILL2-'+tag,partId,quantity:5,unitCost:'200.00',
  date:'2026-11-20',dueDate:'2026-11-20'
 });
 assert.equal(p2.status,201,JSON.stringify(p2.body));
 let control=await get('/api/reports/reconciliation');
 assert.equal(control.body.reconciled,true,JSON.stringify(control.body));
 const retBody={billId:p1.body.id,quantity:2,date:'2026-11-20',reason:'Vendor accepted defective parts',clientKey:randomUUID()};
 assert.equal((await post('/api/phase5/purchase-returns',retBody,'PARTS')).status,403);
 const ret=await post('/api/phase5/purchase-returns',retBody);
 assert.equal(ret.status,201,JSON.stringify(ret.body));
 assert.equal(ret.body.supplier_credit_paisa,'20000');
 assert.equal((await post('/api/phase5/purchase-returns',retBody)).status,409,'Return key blocks duplicates');
 const partNow=(await get('/api/auto/parts','PARTS')).body.parts.find(p=>p.id===partId);
 assert.equal(partNow.stock_qty,8);
 assert.equal(partNow.inventory_value_paisa,'120000');
 const bills=(await get('/api/finance4/purchases')).body.purchases;
 assert.equal(bills.find(p=>p.id===p1.body.id).outstanding_paisa,'30000');
 assert.equal((await post('/api/phase5/purchase-returns',{
  billId:p1.body.id,quantity:4,date:'2026-11-20',reason:'Too many parts',clientKey:randomUUID()
 })).status,409);
 control=await get('/api/reports/reconciliation');
 assert.equal(control.body.reconciled,true,JSON.stringify(control.body));
 const ap=await get('/api/phase5/reports/ap-aging');
 assert.equal(ap.status,200);assert.equal(ap.body.rows.length,2);
 assert.equal(ap.body.rows.find(x=>x.reference===p1.body.reference).outstanding_paisa,'30000');

 // Accounted vehicle sale; configured sales tax is snapshotted on the invoice.
 const vehicle=await post('/api/finance4/purchases/vehicle',{
  supplierId,supplierInvoiceNo:'AUTO1-'+tag,chassis:'VIN-'+tag,variant:'Corolla QA',
  color:'Blue',listPrice:'4500000',cost:'3000000',
  date:'2026-11-20',dueDate:'2026-11-20'
 });
 assert.equal(vehicle.status,201,JSON.stringify(vehicle.body));
 const customer=await post('/api/auto/customers',{name:'Testing Buyer'},'SALES');
 assert.equal(customer.status,201);
 const booking=await post('/api/auto/sales/bookings',{customerId:customer.body.id,vehicleId:vehicle.body.vehicleId,price:'4500000'},'SALES');
 assert.equal(booking.status,201);
 const sale=await post('/api/finance4/sales-invoices',{bookingId:booking.body.id,taxCode:'QA15',date:'2026-11-20',dueDate:'2026-11-20'});
 assert.equal(sale.status,201,JSON.stringify(sale.body));
 assert.equal(sale.body.tax_paisa,'67500000');
 const invoice=(await get('/api/finance4/sales-invoices')).body.invoices.find(x=>x.id===sale.body.id);
 assert.equal(invoice.tax_rate_bps,1500);
 assert.equal(invoice.gross_amount_paisa,'517500000');
 assert.equal(invoice.outstanding_paisa,'517500000');
 assert.equal((await post('/api/phase5/deliveries',{
  invoiceId:sale.body.id,date:'2026-11-20',recipient:'Testing Buyer',odometerKm:8
 },'SALES')).status,409,'Cannot deliver unpaid vehicle');
 let summary=await get('/api/phase5/reports/tax-summary');
 assert.equal(summary.body.net_paisa,'67500000');
 assert.equal(summary.body.reconciled,true,JSON.stringify(summary.body));

 // Price adjustment credits reduce AR, revenue, and configured tax, but not COGS/physical vehicle status.
 const noteData={invoiceId:sale.body.id,netAmount:'100000',date:'2026-11-20',
  reason:'Agreed sales price correction',clientKey:randomUUID()};
 const credit=await post('/api/phase5/credit-notes',noteData);
 assert.equal(credit.status,201,JSON.stringify(credit.body));
 assert.equal(credit.body.net_paisa,'10000000');
 assert.equal(credit.body.tax_paisa,'1500000');
 assert.equal((await post('/api/phase5/credit-notes',noteData)).status,409);
 const invoiceAfter=(await get('/api/finance4/sales-invoices')).body.invoices.find(x=>x.id===sale.body.id);
 assert.equal(invoiceAfter.outstanding_paisa,'506000000');
 summary=await get('/api/phase5/reports/tax-summary');
 assert.equal(summary.body.net_paisa,'66000000');
 assert.equal(summary.body.reconciled,true);
 const margins=await get('/api/phase5/reports/sales-margin','SALES');
 assert.equal(margins.status,200);
 assert.equal(margins.body.totals.gross_margin_paisa,'140000000');
 const aging=await get('/api/reports/ar-aging');
 assert.equal(aging.body.rows.find(x=>x.reference===sale.body.reference).outstanding_paisa,'506000000');

 // Funds arrive via separate bank posting, then delivery is permitted once fully settled.
 const payment=await post('/api/finance4/sales-invoices/'+sale.body.id+'/payments',{
  amount:'5060000',date:'2026-11-20',clientKey:randomUUID()
 });
 assert.equal(payment.status,201,JSON.stringify(payment.body));
 const handover={invoiceId:sale.body.id,date:'2026-11-20',recipient:'Testing Buyer',odometerKm:8,notes:'Keys and manual delivered'};
 assert.equal((await post('/api/phase5/deliveries',handover,'FINANCE')).status,403);
 const delivery=await post('/api/phase5/deliveries',handover,'SALES');
 assert.equal(delivery.status,201,JSON.stringify(delivery.body));
 assert.match(delivery.body.reference,/^DL\/2611000001$/);
 assert.equal((await post('/api/phase5/deliveries',handover,'SALES')).status,409);
 const deliveryRow=await pool.query('SELECT id FROM vehicle_deliveries WHERE company_id=$1 AND invoice_id=$2',[company,sale.body.id]);
 await assert.rejects(pool.query('DELETE FROM vehicle_deliveries WHERE id=$1',[deliveryRow.rows[0].id]),/cannot be edited or deleted/);
 control=await get('/api/reports/reconciliation');
 assert.equal(control.body.reconciled,true,JSON.stringify(control.body));
 assert.ok(control.body.checks.every(x=>x.difference_paisa==='0'));
 const doc=await pool.query('SELECT tax_voucher_id FROM vehicle_sales_invoices WHERE company_id=$1 AND id=$2',[company,sale.body.id]);
 assert.equal((await post('/api/vouchers/'+doc.rows[0].tax_voucher_id+'/reverse',{date:'2026-11-20',reason:'Unlinked reversal attempt'})).status,409);
});

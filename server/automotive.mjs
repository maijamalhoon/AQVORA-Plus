import {roleAllowed,uuidPattern,stringField,optionalString,paisaField,quantityField,dateField,nextJobStatus} from './automotive-rules.mjs';
import {validDate} from './logic.mjs';

const todayUTC=()=>new Date().toISOString().slice(0,10);
const uuidValue=(v,fail,label='Identifier')=>{if(typeof v!=='string'||!uuidPattern.test(v))fail(400,label+' is invalid');return v;};
const queryList=(r)=>r.rows;
export async function handleAutomotiveApi({req,res,pool,ctx,uri,path,send,fail,readJson,tx,postExisting,openPeriod}){
  if(!path.startsWith('/api/auto/')&&path!=='/api/reports/ar-aging')return false;
  const company=ctx.selected.company_id, actor=ctx.user.id,role=ctx.selected.role;
  const permitted=action=>{if(!roleAllowed(role,action))fail(403,'This role cannot access the requested dealership feature');};
  const validated=async fn=>{
    const body=await readJson(req);
    try{return fn(body);}catch(e){fail(400,e.message);}
  };
  const audit=async (db,action,id,meta={})=>
    db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',[company,actor,action,id,JSON.stringify(meta)]);
  const nextDocument=async(db,type,date)=>{
    const r=await db.query(
      'INSERT INTO document_sequences(company_id,code,period,last_number) VALUES($1,$2,$3,1) ON CONFLICT(company_id,code,period) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number',
      [company,type,date.slice(0,7)]);
    if(r.rows[0].last_number>999999)fail(409,'Document sequence exhausted');
    return type+'/'+date.slice(2,4)+date.slice(5,7)+String(r.rows[0].last_number).padStart(6,'0');
  };
  const accounts=async(db,codes)=>{
    const found=await db.query('SELECT id,code FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]);
    if(found.rowCount!==codes.length)fail(409,'Required company accounts are missing or inactive: '+codes.join(', '));
    return new Map(found.rows.map(r=>[r.code,r.id]));
  };
  const department=async(db,code)=>{
    const r=await db.query('SELECT id FROM departments WHERE company_id=$1 AND code=$2',[company,code]);
    if(!r.rowCount)fail(409,'Missing department: '+code);
    return r.rows[0].id;
  };
  const postJournal=async(db,{type,date,departmentId,narrative,debit,credit,amount})=>{
    await openPeriod(db,company,date);
    const created=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [company,departmentId,type,date,narrative,actor]);
    const id=created.rows[0].id;
    await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,1,$4,0),($1,$2,$5,2,0,$4)',
      [company,id,debit,amount,credit]);
    const number=await postExisting(db,ctx,{id,status:'DRAFT',voucher_type:type,voucher_date:date});
    return {id,number};
  };
  const isGet=req.method==='GET',isPost=req.method==='POST';
  // Customer master (only scoped users can read personal data).
  if(path==='/api/auto/customers'&&isGet){
    permitted('customers_read');
    const r=await pool.query('SELECT id,name,phone,email,created_at FROM customers WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200',[company]);
    send(res,200,{customers:queryList(r)});return true;
  }
  if(path==='/api/auto/customers'&&isPost){
    permitted('customers_write');
    const input=await validated(x=>({name:stringField(x.name,'Customer name'),phone:optionalString(x.phone,'Phone',35),email:optionalString(x.email,'Email',200)}));
    const r=await tx(pool,async db=>{
      const created=await db.query('INSERT INTO customers(company_id,name,phone,email,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [company,input.name,input.phone,input.email,actor]);
      await audit(db,'CUSTOMER_CREATED',created.rows[0].id);
      return created.rows[0];
    });
    send(res,201,r);return true;
  }
  if(path==='/api/auto/customer-vehicles'&&isGet){
    permitted('service_read');
    const r=await pool.query(
      'SELECT v.id,v.customer_id,v.registration,v.chassis,v.model,c.name AS customer_name FROM customer_vehicles v JOIN customers c ON c.company_id=v.company_id AND c.id=v.customer_id WHERE v.company_id=$1 ORDER BY v.created_at DESC LIMIT 200',[company]);
    send(res,200,{vehicles:r.rows});return true;
  }
  if(path==='/api/auto/customer-vehicles'&&isPost){
    permitted('service_write');
    const input=await validated(x=>({customerId:uuidValue(x.customerId,fail,'Customer'),registration:stringField(x.registration,'Registration',40),chassis:stringField(x.chassis,'Chassis',80,4),model:stringField(x.model,'Model')}));
    const r=await tx(pool,async db=>{
      const c=await db.query('SELECT id FROM customers WHERE company_id=$1 AND id=$2',[company,input.customerId]);
      if(!c.rowCount)fail(404,'Customer not found');
      const v=await db.query('INSERT INTO customer_vehicles(company_id,customer_id,registration,chassis,model) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [company,input.customerId,input.registration,input.chassis,input.model]);
      await audit(db,'CUSTOMER_VEHICLE_CREATED',v.rows[0].id);
      return v.rows[0];
    });
    send(res,201,r);return true;
  }
  // New vehicle stock and reservations: booking does not post sales revenue.
  if(path==='/api/auto/vehicle-stock'&&isGet){
    permitted('sales_read');
    const r=await pool.query('SELECT id,chassis,variant,color,list_price_paisa::text,status FROM vehicle_stock WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200',[company]);
    send(res,200,{vehicles:r.rows});return true;
  }
  if(path==='/api/auto/vehicle-stock'&&isPost){
    permitted('sales_write');
    const input=await validated(x=>({chassis:stringField(x.chassis,'Chassis',80,4),variant:stringField(x.variant,'Variant'),color:optionalString(x.color,'Colour',80),price:paisaField(x.price,'List price')}));
    const r=await tx(pool,async db=>{
      const v=await db.query('INSERT INTO vehicle_stock(company_id,chassis,variant,color,list_price_paisa) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [company,input.chassis,input.variant,input.color,input.price]);
      await audit(db,'VEHICLE_STOCK_CREATED',v.rows[0].id);
      return v.rows[0];
    });
    send(res,201,r);return true;
  }
  if(path==='/api/auto/sales/bookings'&&isGet){
    permitted('sales_read');
    const r=await pool.query(
      'SELECT b.id,b.reference,b.agreed_price_paisa::text,b.status,b.created_at,c.name AS customer_name,v.chassis,v.variant FROM sales_bookings b JOIN customers c ON c.company_id=b.company_id AND c.id=b.customer_id JOIN vehicle_stock v ON v.company_id=b.company_id AND v.id=b.vehicle_id WHERE b.company_id=$1 ORDER BY b.created_at DESC LIMIT 200',[company]);
    send(res,200,{bookings:r.rows});return true;
  }
  if(path==='/api/auto/sales/bookings'&&isPost){
    permitted('sales_write');
    const input=await validated(x=>({customerId:uuidValue(x.customerId,fail,'Customer'),vehicleId:uuidValue(x.vehicleId,fail,'Vehicle'),price:paisaField(x.price,'Agreed price')}));
    const result=await tx(pool,async db=>{
      const cust=await db.query('SELECT id FROM customers WHERE company_id=$1 AND id=$2',[company,input.customerId]);
      if(!cust.rowCount)fail(404,'Customer not found');
      const vehicle=await db.query('SELECT id,status FROM vehicle_stock WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.vehicleId]);
      if(!vehicle.rowCount)fail(404,'Stock vehicle not found');
      if(vehicle.rows[0].status!=='IN_STOCK')fail(409,'Stock vehicle is already reserved');
      const reference=await nextDocument(db,'SO',todayUTC());
      const booking=await db.query(
        'INSERT INTO sales_bookings(company_id,reference,customer_id,vehicle_id,agreed_price_paisa,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,reference',
        [company,reference,input.customerId,input.vehicleId,input.price,actor]);
      await db.query("UPDATE vehicle_stock SET status='RESERVED' WHERE company_id=$1 AND id=$2",[company,input.vehicleId]);
      await audit(db,'VEHICLE_BOOKED',booking.rows[0].id,{vehicleId:input.vehicleId,reference});
      return booking.rows[0];
    });
    send(res,201,result);return true;
  }
  const cancel=/^\/api\/auto\/sales\/bookings\/([a-f0-9-]{36})\/cancel$/i.exec(path);
  if(cancel&&isPost){
    permitted('sales_write');uuidValue(cancel[1],fail,'Booking');
    const result=await tx(pool,async db=>{
      const r=await db.query('SELECT id,vehicle_id,status,reference FROM sales_bookings WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,cancel[1]]);
      if(!r.rowCount)fail(404,'Booking not found');
      if(r.rows[0].status!=='BOOKED')fail(409,'Booking has already been cancelled');
      const sold=await db.query('SELECT id FROM vehicle_sales_invoices WHERE company_id=$1 AND booking_id=$2',[company,cancel[1]]);
      if(sold.rowCount)fail(409,'Cannot cancel an invoiced vehicle booking');
      await db.query("UPDATE sales_bookings SET status='CANCELLED',cancelled_at=now() WHERE company_id=$1 AND id=$2",[company,cancel[1]]);
      await db.query("UPDATE vehicle_stock SET status='IN_STOCK' WHERE company_id=$1 AND id=$2",[company,r.rows[0].vehicle_id]);
      await audit(db,'VEHICLE_BOOKING_CANCELLED',cancel[1],{reference:r.rows[0].reference});
      return {id:cancel[1],status:'CANCELLED'};
    });
    send(res,200,result);return true;
  }
  // Workshop job-card lifecycle. Invoicing only after completion.
  if(path==='/api/auto/service/jobs'&&isGet){
    permitted('service_read');
    const r=await pool.query(
      'SELECT j.id,j.reference,j.complaint,j.status,j.created_at,v.registration,v.model,v.chassis,c.name AS customer_name FROM service_jobs j JOIN customer_vehicles v ON v.company_id=j.company_id AND v.id=j.vehicle_id JOIN customers c ON c.company_id=v.company_id AND c.id=v.customer_id WHERE j.company_id=$1 ORDER BY j.created_at DESC LIMIT 200',[company]);
    send(res,200,{jobs:r.rows});return true;
  }
  if(path==='/api/auto/service/jobs'&&isPost){
    permitted('service_write');
    const input=await validated(x=>({vehicleId:uuidValue(x.vehicleId,fail,'Customer vehicle'),complaint:stringField(x.complaint,'Job complaint',2000,3)}));
    const result=await tx(pool,async db=>{
      const v=await db.query('SELECT id FROM customer_vehicles WHERE company_id=$1 AND id=$2',[company,input.vehicleId]);
      if(!v.rowCount)fail(404,'Customer vehicle not found');
      const reference=await nextDocument(db,'JC',todayUTC());
      const r=await db.query('INSERT INTO service_jobs(company_id,reference,vehicle_id,complaint,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,reference,status',
        [company,reference,input.vehicleId,input.complaint,actor]);
      await audit(db,'JOB_CARD_CREATED',r.rows[0].id,{reference});
      return r.rows[0];
    });
    send(res,201,result);return true;
  }
  const jobStatus=/^\/api\/auto\/service\/jobs\/([a-f0-9-]{36})\/status$/i.exec(path);
  if(jobStatus&&isPost){
    permitted('service_write');uuidValue(jobStatus[1],fail,'Job');
    const data=await validated(x=>({status:stringField(x.status,'New status',30)}));
    const result=await tx(pool,async db=>{
      const job=await db.query('SELECT id,status FROM service_jobs WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,jobStatus[1]]);
      if(!job.rowCount)fail(404,'Job not found');
      try{nextJobStatus(job.rows[0].status,data.status);}
      catch{fail(409,'Invalid job lifecycle transition');}
      await db.query("UPDATE service_jobs SET status=$1,completed_at=CASE WHEN $1='COMPLETED' THEN now() ELSE completed_at END WHERE company_id=$2 AND id=$3",[data.status,company,jobStatus[1]]);
      await audit(db,'JOB_STATUS_CHANGED',jobStatus[1],{to:data.status});
      return {id:jobStatus[1],status:data.status};
    });
    send(res,200,result);return true;
  }
  // Parts stock ledger. Stock movements are immutable, no negative stock allowed.
  if(path==='/api/auto/parts'&&isGet){
    permitted('parts_read');
    const r=await pool.query('SELECT id,sku,name,unit_cost_paisa::text,stock_qty,inventory_value_paisa::text,valuation_mode FROM parts WHERE company_id=$1 ORDER BY sku LIMIT 300',[company]);
    send(res,200,{parts:r.rows});return true;
  }
  if(path==='/api/auto/parts'&&isPost){
    permitted('parts_write');
    const input=await validated(x=>({sku:stringField(x.sku,'SKU',50).toUpperCase(),name:stringField(x.name,'Part name')}));
    const r=await tx(pool,async db=>{
      const p=await db.query('INSERT INTO parts(company_id,sku,name) VALUES($1,$2,$3) RETURNING id',[company,input.sku,input.name]);
      await audit(db,'PART_CREATED',p.rows[0].id,{sku:input.sku});
      return p.rows[0];
    });
    send(res,201,r);return true;
  }
  if(path==='/api/auto/stock-movements'&&isGet){
    permitted('parts_read');
    const r=await pool.query(
      'SELECT m.id,m.direction,m.quantity,m.unit_cost_paisa::text,m.reference,m.created_at,p.sku,j.reference AS job_reference FROM stock_movements m JOIN parts p ON p.company_id=m.company_id AND p.id=m.part_id LEFT JOIN service_jobs j ON j.company_id=m.company_id AND j.id=m.job_id WHERE m.company_id=$1 ORDER BY m.created_at DESC LIMIT 200',[company]);
    send(res,200,{movements:r.rows});return true;
  }
  if(path==='/api/auto/stock-movements'&&isPost){
    permitted('parts_write');
    const input=await validated(x=>{
      const direction=stringField(x.direction,'Movement direction',15);
      if(!['RECEIPT','ISSUE'].includes(direction))throw Error('Unsupported stock movement');
      return {direction,partId:uuidValue(x.partId,fail,'Part'),quantity:quantityField(x.quantity),
        reference:stringField(x.reference,'Document reference',120),
        jobId:direction==='ISSUE'?uuidValue(x.jobId,fail,'Job'):null,
        unitCost:direction==='RECEIPT'?paisaField(x.unitCost,'Unit purchase cost'):null};
    });
    const result=await tx(pool,async db=>{
      const part=await db.query('SELECT id,sku,stock_qty,unit_cost_paisa::text FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.partId]);
      if(!part.rowCount)fail(404,'Part not found');
      const current=part.rows[0];
      if(input.direction==='ISSUE'){
        if(current.stock_qty<input.quantity)fail(409,'Insufficient available stock');
        const job=await db.query('SELECT status FROM service_jobs WHERE company_id=$1 AND id=$2',[company,input.jobId]);
        if(!job.rowCount)fail(404,'Job not found');
        if(job.rows[0].status==='COMPLETED')fail(409,'Cannot issue stock to a completed job');
      }
      const cost=input.direction==='RECEIPT'?input.unitCost:BigInt(current.unit_cost_paisa);
      const result=await db.query('INSERT INTO stock_movements(company_id,part_id,direction,quantity,unit_cost_paisa,reference,job_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [company,input.partId,input.direction,input.quantity,String(cost),input.reference,input.jobId,actor]);
      if(input.direction==='RECEIPT')await db.query('UPDATE parts SET stock_qty=stock_qty+$1,unit_cost_paisa=$2 WHERE company_id=$3 AND id=$4',[input.quantity,String(cost),company,input.partId]);
      else await db.query('UPDATE parts SET stock_qty=stock_qty-$1 WHERE company_id=$2 AND id=$3',[input.quantity,company,input.partId]);
      await audit(db,'STOCK_'+input.direction,result.rows[0].id,{partId:input.partId,qty:input.quantity,reference:input.reference});
      return result.rows[0];
    });
    send(res,201,result);return true;
  }
  // Invoice only labor in this initial slice; parts billing / tax / COGS not yet implemented.
  if(path==='/api/auto/service/invoices'&&isGet){
    permitted('invoice_read');
    const r=await pool.query(
      'SELECT i.id,i.reference,i.invoice_date::text,i.due_date::text,i.labor_amount_paisa::text,i.paid_paisa::text,(i.labor_amount_paisa-i.paid_paisa)::text AS balance_paisa,j.reference AS job_reference,c.name AS customer_name FROM service_invoices i JOIN service_jobs j ON j.id=i.job_id AND j.company_id=i.company_id JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id WHERE i.company_id=$1 ORDER BY i.created_at DESC LIMIT 200',[company]);
    send(res,200,{invoices:r.rows});return true;
  }
  if(path==='/api/auto/service/invoices'&&isPost){
    permitted('invoice_write');
    const input=await validated(x=>({
      jobId:uuidValue(x.jobId,fail,'Job'),amount:paisaField(x.laborAmount,'Labor amount'),
      date:dateField(x.date,'Invoice date'),due:dateField(x.dueDate,'Due date')
    }));
    if(input.due<input.date)fail(400,'Due date cannot precede invoice date');
    const result=await tx(pool,async db=>{
      const j=await db.query(
        'SELECT j.id,j.status,j.reference,v.customer_id FROM service_jobs j JOIN customer_vehicles v ON v.company_id=j.company_id AND v.id=j.vehicle_id WHERE j.company_id=$1 AND j.id=$2 FOR UPDATE OF j',
        [company,input.jobId]);
      if(!j.rowCount)fail(404,'Job not found');
      if(j.rows[0].status!=='COMPLETED')fail(409,'Only completed jobs may be invoiced');
      const existing=await db.query('SELECT id FROM service_invoices WHERE company_id=$1 AND job_id=$2',[company,input.jobId]);
      if(existing.rowCount)fail(409,'This job has already been invoiced');
      const gl=await accounts(db,['1020301001','4010101001']);
      const dept=await department(db,'SERVICE');
      const ref=await nextDocument(db,'SI',input.date);
      const ledger=await postJournal(db,{type:'JV',date:input.date,departmentId:dept,
        narrative:'Service labor invoice '+ref+' against job '+j.rows[0].reference,
        debit:gl.get('1020301001'),credit:gl.get('4010101001'),amount:input.amount});
      const r=await db.query(
        'INSERT INTO service_invoices(company_id,reference,job_id,customer_id,invoice_date,due_date,labor_amount_paisa,voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,reference',
        [company,ref,input.jobId,j.rows[0].customer_id,input.date,input.due,input.amount,ledger.id,actor]);
      await audit(db,'SERVICE_INVOICE_ISSUED',r.rows[0].id,{reference:ref,posting:ledger.number});
      return {...r.rows[0],journal:ledger.number};
    });
    send(res,201,result);return true;
  }
  const payment=/^\/api\/auto\/service\/invoices\/([a-f0-9-]{36})\/payments$/i.exec(path);
  if(payment&&isPost){
    permitted('invoice_write');uuidValue(payment[1],fail,'Invoice');
    const input=await validated(x=>({amount:paisaField(x.amount,'Payment amount'),date:dateField(x.date,'Receipt date')}));
    const result=await tx(pool,async db=>{
      const inv=await db.query('SELECT id,reference,labor_amount_paisa::text,paid_paisa::text FROM service_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,payment[1]]);
      if(!inv.rowCount)fail(404,'Invoice not found');
      const outstanding=BigInt(inv.rows[0].labor_amount_paisa)-BigInt(inv.rows[0].paid_paisa);
      if(BigInt(input.amount)>outstanding)fail(409,'Payment exceeds outstanding invoice amount');
      const gl=await accounts(db,['1020402001','1020301001']);
      const dept=await department(db,'FINANCE');
      const ledger=await postJournal(db,{type:'BB/R',date:input.date,departmentId:dept,
        narrative:'Payment against invoice '+inv.rows[0].reference,
        debit:gl.get('1020402001'),credit:gl.get('1020301001'),amount:input.amount});
      const received=await db.query('INSERT INTO service_invoice_payments(company_id,invoice_id,amount_paisa,voucher_id,received_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [company,payment[1],input.amount,ledger.id,input.date,actor]);
      await db.query('UPDATE service_invoices SET paid_paisa=paid_paisa+$1 WHERE company_id=$2 AND id=$3',
        [input.amount,company,payment[1]]);
      await audit(db,'SERVICE_INVOICE_PAYMENT',received.rows[0].id,{invoiceId:payment[1],posting:ledger.number});
      return {id:received.rows[0].id,journal:ledger.number};
    });
    send(res,201,result);return true;
  }
  if(path==='/api/reports/ar-aging'&&isGet){
    permitted('ar_read');
    const r=await pool.query(
      "SELECT 'SERVICE' AS invoice_type,i.reference,i.invoice_date::text,i.due_date::text,c.name AS customer_name,"+
      "i.labor_amount_paisa::text AS total_paisa,i.paid_paisa::text,(i.labor_amount_paisa-i.paid_paisa)::text AS outstanding_paisa,GREATEST(0,CURRENT_DATE-i.due_date) AS days_overdue "+
      "FROM service_invoices i JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id "+
      "WHERE i.company_id=$1 AND i.paid_paisa<i.labor_amount_paisa "+
      "UNION ALL "+
      "SELECT 'VEHICLE' AS invoice_type,i.reference,i.invoice_date::text,i.due_date::text,c.name AS customer_name,"+
      "i.sales_amount_paisa::text AS total_paisa,i.paid_paisa::text,(i.sales_amount_paisa-i.paid_paisa)::text AS outstanding_paisa,GREATEST(0,CURRENT_DATE-i.due_date) AS days_overdue "+
      "FROM vehicle_sales_invoices i JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id "+
      "WHERE i.company_id=$1 AND i.paid_paisa<i.sales_amount_paisa ORDER BY due_date,reference LIMIT 300",
      [company]);
    send(res,200,{rows:r.rows,scope:'CURRENT_OUTSTANDING_ONLY',as_of:todayUTC()});return true;
  }
  return false;
}

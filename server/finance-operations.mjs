import {uuidPattern,stringField,optionalString,paisaField,quantityField,dateField} from './automotive-rules.mjs';

const checkUuid=(v,fail,label='ID')=>{if(typeof v!=='string'||!uuidPattern.test(v))fail(400,label+' invalid');return v;};
const parseInput=async(readJson,fail,fn)=>{const input=await readJson();try{return fn(input);}catch(e){fail(400,e.message);}};
const moneySafe=(value,fail)=>{if(!Number.isSafeInteger(value)||value<1)fail(400,'Amount exceeds the safe monetary range');return value;};

export async function handlePhase4Api({req,res,pool,ctx,uri,path,send,fail,readJson,tx,postExisting,openPeriod}){
  if(!path.startsWith('/api/finance4/')&&path!=='/api/reports/reconciliation')return false;
  const company=ctx.selected.company_id, actor=ctx.user.id, role=ctx.selected.role;
  const readAllowed=['ADMIN','FINANCE','SALES','PARTS'].includes(role);
  const financeAllowed=['ADMIN','FINANCE'].includes(role);
  const mustRead=()=>{if(!readAllowed)fail(403,'Your role cannot view these financial operations');};
  const mustFinance=()=>{if(!financeAllowed)fail(403,'Only Finance or Admin can post financial operations');};
  const read=fn=>parseInput(()=>readJson(req),fail,fn);
  const audit=async(db,action,entity,meta={})=>{
    await db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',[company,actor,action,entity,JSON.stringify(meta)]);
  };
  const accounts=async(db,codes)=>{
    const r=await db.query('SELECT code,id FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]);
    if(r.rowCount!==codes.length)fail(409,'Required accounting control accounts are missing: '+codes.join(', '));
    return new Map(r.rows.map(x=>[x.code,x.id]));
  };
  const department=async(db,code)=>{
    const r=await db.query('SELECT id FROM departments WHERE company_id=$1 AND code=$2',[company,code]);
    if(!r.rowCount)fail(409,'Department missing: '+code);
    return r.rows[0].id;
  };
  const nextDoc=async(db,code,date)=>{
    const r=await db.query('INSERT INTO document_sequences(company_id,code,period,last_number) VALUES($1,$2,$3,1) ON CONFLICT(company_id,code,period) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number',[company,code,date.slice(0,7)]);
    const n=r.rows[0].last_number;
    if(n>999999)fail(409,'Document number exhausted');
    return code+'/'+date.slice(2,4)+date.slice(5,7)+String(n).padStart(6,'0');
  };
  const journal=async(db,{type='JV',departmentCode='FINANCE',date,narrative,debit,credit,value})=>{
    await openPeriod(db,company,date);
    const cost=moneySafe(value,fail);
    if(debit===credit)fail(409,'Financial control accounts must be distinct');
    const dept=await department(db,departmentCode);
    const created=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [company,dept,type,date,narrative,actor]);
    const voucher=created.rows[0].id;
    await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,1,$4,0),($1,$2,$5,2,0,$4)',
      [company,voucher,debit,cost,credit]);
    const number=await postExisting(db,ctx,{id:voucher,status:'DRAFT',voucher_type:type,voucher_date:date});
    return {id:voucher,number};
  };
  const get=req.method==='GET',post=req.method==='POST';

  if(path==='/api/finance4/suppliers'&&get){
    mustRead();
    const r=await pool.query('SELECT id,name,phone FROM suppliers WHERE company_id=$1 ORDER BY name LIMIT 200',[company]);
    send(res,200,{suppliers:r.rows});return true;
  }
  if(path==='/api/finance4/suppliers'&&post){
    mustFinance();
    const input=await read(x=>({name:stringField(x.name,'Supplier name'),phone:optionalString(x.phone,'Phone',35)}));
    const r=await tx(pool,async db=>{
      const c=await db.query('INSERT INTO suppliers(company_id,name,phone,created_by) VALUES($1,$2,$3,$4) RETURNING id,name',[company,input.name,input.phone,actor]);
      await audit(db,'SUPPLIER_CREATED',c.rows[0].id);
      return c.rows[0];
    });
    send(res,201,r);return true;
  }
  if(path==='/api/finance4/purchases'&&get){
    mustRead();
    const r=await pool.query("SELECT b.id,b.reference,b.supplier_invoice_no,b.bill_type,b.invoice_date::text,b.due_date::text,b.amount_paisa::text,b.paid_paisa::text,(b.amount_paisa-b.paid_paisa)::text AS outstanding_paisa,s.name AS supplier_name,b.quantity FROM purchase_bills b JOIN suppliers s ON s.company_id=b.company_id AND s.id=b.supplier_id WHERE b.company_id=$1 ORDER BY b.created_at DESC LIMIT 200",[company]);
    send(res,200,{purchases:r.rows});return true;
  }
  const vehiclePurchase=path==='/api/finance4/purchases/vehicle'&&post;
  const partsPurchase=path==='/api/finance4/purchases/parts'&&post;
  if(vehiclePurchase||partsPurchase){
    mustFinance();
    const input=await read(x=>{
      const core={
        supplierId:checkUuid(x.supplierId,fail,'Supplier'),
        supplierInvoiceNo:stringField(x.supplierInvoiceNo,'Supplier invoice number',80),
        date:dateField(x.date,'Invoice date'),
        dueDate:dateField(x.dueDate,'Due date')
      };
      if(core.dueDate<core.date)throw Error('Due date must be on/after invoice date');
      if(vehiclePurchase)return {...core,chassis:stringField(x.chassis,'Chassis',80,4),variant:stringField(x.variant,'Variant'),
        color:optionalString(x.color,'Color',80),listPrice:paisaField(x.listPrice,'List price'),
        cost:paisaField(x.cost,'Vehicle purchase cost')};
      return {...core,partId:checkUuid(x.partId,fail,'Part'),quantity:quantityField(x.quantity),unitCost:paisaField(x.unitCost,'Unit cost')};
    });
    const saved=await tx(pool,async db=>{
      const supplier=await db.query('SELECT id FROM suppliers WHERE company_id=$1 AND id=$2',[company,input.supplierId]);
      if(!supplier.rowCount)fail(404,'Supplier not found');
      const amount=vehiclePurchase?input.cost:moneySafe(input.quantity*input.unitCost,fail);
      const gl=await accounts(db,vehiclePurchase?['1020501001','2010101001']:['1020601001','2010101001']);
      const reference=await nextDoc(db,'PI',input.date);
      let vehicle=null,part=null;
      if(vehiclePurchase){
        const v=await db.query('INSERT INTO vehicle_stock(company_id,chassis,variant,color,list_price_paisa) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [company,input.chassis,input.variant,input.color,input.listPrice]);
        vehicle=v.rows[0].id;
      } else {
        const p=await db.query('SELECT id,stock_qty,inventory_value_paisa::text,valuation_mode FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.partId]);
        if(!p.rowCount)fail(404,'Part not found');
        part=p.rows[0];
        if(part.valuation_mode==='LEGACY'){
          const legacy=await db.query('SELECT 1 FROM stock_movements WHERE company_id=$1 AND part_id=$2 LIMIT 1',[company,input.partId]);
          if(legacy.rowCount||part.stock_qty!==0)fail(409,'Part has legacy, unposted stock history; accounting migration required first');
        }
      }
      const ledger=await journal(db,{
        date:input.date,departmentCode:vehiclePurchase?'SALES':'PARTS',
        narrative:'Supplier invoice '+input.supplierInvoiceNo+' / '+reference,
        debit:gl.get(vehiclePurchase?'1020501001':'1020601001'),
        credit:gl.get('2010101001'),value:amount
      });
      if(vehiclePurchase){
        await db.query('UPDATE vehicle_stock SET purchase_cost_paisa=$1,acquisition_voucher_id=$2 WHERE company_id=$3 AND id=$4',
          [amount,ledger.id,company,vehicle]);
      }else{
        const oldValue=BigInt(part.inventory_value_paisa),newValue=oldValue+BigInt(amount);
        const newQty=part.stock_qty+input.quantity;
        if(!Number.isSafeInteger(newQty)||newValue>BigInt(Number.MAX_SAFE_INTEGER))fail(400,'Inventory quantity/value exceeds safe range');
        const average=(newValue+BigInt(newQty)/2n)/BigInt(newQty);
        await db.query(
          'INSERT INTO stock_movements(company_id,part_id,direction,quantity,unit_cost_paisa,reference,job_id,created_by,accounting_voucher_id,cost_total_paisa) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)',
          [company,input.partId,'RECEIPT',input.quantity,input.unitCost,reference,actor,ledger.id,amount]);
        await db.query("UPDATE parts SET stock_qty=$1,inventory_value_paisa=$2,unit_cost_paisa=$3,valuation_mode='POSTED' WHERE company_id=$4 AND id=$5",
          [newQty,newValue.toString(),average.toString(),company,input.partId]);
      }
      const p=await db.query('INSERT INTO purchase_bills(company_id,supplier_id,supplier_invoice_no,reference,bill_type,invoice_date,due_date,amount_paisa,voucher_id,vehicle_id,part_id,quantity,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,reference',
        [company,input.supplierId,input.supplierInvoiceNo,reference,vehiclePurchase?'VEHICLE':'PARTS',
          input.date,input.dueDate,amount,ledger.id,vehicle,part?input.partId:null,part?input.quantity:null,actor]);
      await audit(db,'PURCHASE_ACCOUNTED',p.rows[0].id,{reference,kind:vehiclePurchase?'VEHICLE':'PARTS',journal:ledger.number});
      return {...p.rows[0],journal:ledger.number,vehicleId:vehicle};
    });
    send(res,201,saved);return true;
  }

  if(path==='/api/finance4/parts/issue'&&post){
    mustFinance();
    const input=await read(x=>({
      partId:checkUuid(x.partId,fail,'Part'),jobId:checkUuid(x.jobId,fail,'Job'),
      quantity:quantityField(x.quantity),reference:stringField(x.reference,'Issue reference',120),
      date:dateField(x.date,'Issue date')
    }));
    const result=await tx(pool,async db=>{
      const part=await db.query('SELECT id,stock_qty,inventory_value_paisa::text,valuation_mode FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.partId]);
      if(!part.rowCount)fail(404,'Part not found');
      const p=part.rows[0];
      if(p.valuation_mode!=='POSTED')fail(409,'This part has not been migrated to accounted inventory');
      if(p.stock_qty<input.quantity)fail(409,'Insufficient available parts stock');
      const job=await db.query('SELECT id,status FROM service_jobs WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,input.jobId]);
      if(!job.rowCount)fail(404,'Job not found');
      if(job.rows[0].status==='COMPLETED')fail(409,'Cannot issue to completed job');
      const value=BigInt(p.inventory_value_paisa),q=BigInt(p.stock_qty),use=BigInt(input.quantity);
      const issueCost=use===q?value:(value*use+q/2n)/q;
      if(issueCost<1n||issueCost>BigInt(Number.MAX_SAFE_INTEGER))fail(409,'Invalid calculated stock cost');
      const gl=await accounts(db,['5010501001','1020601001']);
      const ledger=await journal(db,{date:input.date,departmentCode:'PARTS',narrative:'Accounted stock issue '+input.reference,
        debit:gl.get('5010501001'),credit:gl.get('1020601001'),value:Number(issueCost)});
      const movement=await db.query(
        'INSERT INTO stock_movements(company_id,part_id,direction,quantity,unit_cost_paisa,reference,job_id,created_by,accounting_voucher_id,cost_total_paisa) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [company,input.partId,'ISSUE',input.quantity,(issueCost+use/2n)/use,input.reference,input.jobId,actor,ledger.id,issueCost]);
      const remaining=value-issueCost,remainingQty=p.stock_qty-input.quantity;
      const avg=remainingQty?(remaining+BigInt(remainingQty)/2n)/BigInt(remainingQty):0n;
      await db.query('UPDATE parts SET stock_qty=$1,inventory_value_paisa=$2,unit_cost_paisa=$3 WHERE company_id=$4 AND id=$5',
        [remainingQty,remaining.toString(),avg.toString(),company,input.partId]);
      await audit(db,'PARTS_COGS_POSTED',movement.rows[0].id,{jobId:input.jobId,journal:ledger.number,cost:issueCost.toString()});
      return {movementId:movement.rows[0].id,journal:ledger.number,cost_paisa:issueCost.toString()};
    });
    send(res,201,result);return true;
  }

  const supplierPayment=/^\/api\/finance4\/purchases\/([a-f0-9-]{36})\/payments$/i.exec(path);
  if(supplierPayment&&post){
    mustFinance();checkUuid(supplierPayment[1],fail,'Purchase');
    const input=await read(x=>({amount:paisaField(x.amount,'Payment'),date:dateField(x.date,'Payment date'),
      clientKey:checkUuid(x.clientKey,fail,'Idempotency key')}));
    const result=await tx(pool,async db=>{
      const b=await db.query('SELECT id,reference,amount_paisa::text,paid_paisa::text FROM purchase_bills WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,supplierPayment[1]]);
      if(!b.rowCount)fail(404,'Supplier bill not found');
      if(BigInt(input.amount)>BigInt(b.rows[0].amount_paisa)-BigInt(b.rows[0].paid_paisa))fail(409,'Payment exceeds unpaid supplier bill');
      const gl=await accounts(db,['2010101001','1020402001']);
      const ledger=await journal(db,{type:'BB/P',date:input.date,departmentCode:'FINANCE',
        narrative:'Supplier payment against '+b.rows[0].reference,
        debit:gl.get('2010101001'),credit:gl.get('1020402001'),value:input.amount});
      const pay=await db.query('INSERT INTO supplier_payments(company_id,bill_id,payment_date,amount_paisa,client_key,voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [company,b.rows[0].id,input.date,input.amount,input.clientKey,ledger.id,actor]);
      await db.query('UPDATE purchase_bills SET paid_paisa=paid_paisa+$1 WHERE company_id=$2 AND id=$3',
        [input.amount,company,b.rows[0].id]);
      await audit(db,'SUPPLIER_PAYMENT_POSTED',pay.rows[0].id,{billId:b.rows[0].id,journal:ledger.number});
      return {paymentId:pay.rows[0].id,journal:ledger.number};
    });
    send(res,201,result);return true;
  }

  if(path==='/api/finance4/sales-invoices'&&get){
    mustRead();
    const r=await pool.query(
      "SELECT i.id,i.reference,i.invoice_date::text,i.due_date::text,i.sales_amount_paisa::text,i.cogs_paisa::text,i.paid_paisa::text,(i.sales_amount_paisa-i.paid_paisa)::text AS outstanding_paisa,c.name AS customer_name,v.chassis,v.variant,b.reference AS booking_reference FROM vehicle_sales_invoices i JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id JOIN vehicle_stock v ON v.company_id=i.company_id AND v.id=i.vehicle_id JOIN sales_bookings b ON b.company_id=i.company_id AND b.id=i.booking_id WHERE i.company_id=$1 ORDER BY i.created_at DESC LIMIT 200",[company]);
    send(res,200,{invoices:r.rows});return true;
  }
  if(path==='/api/finance4/sales-invoices'&&post){
    mustFinance();
    const input=await read(x=>({bookingId:checkUuid(x.bookingId,fail,'Booking'),date:dateField(x.date,'Invoice date'),
      dueDate:dateField(x.dueDate,'Due date')}));
    if(input.dueDate<input.date)fail(400,'Invoice due date precedes issue date');
    const sale=await tx(pool,async db=>{
      const r=await db.query(
        'SELECT b.id,b.customer_id,b.vehicle_id,b.status,b.agreed_price_paisa::text,b.reference AS booking_ref,v.status AS vehicle_status,v.purchase_cost_paisa::text,v.acquisition_voucher_id FROM sales_bookings b JOIN vehicle_stock v ON v.company_id=b.company_id AND v.id=b.vehicle_id WHERE b.company_id=$1 AND b.id=$2 FOR UPDATE OF b,v',
        [company,input.bookingId]);
      if(!r.rowCount)fail(404,'Booking not found');
      const b=r.rows[0];
      if(b.status!=='BOOKED'||b.vehicle_status!=='RESERVED')fail(409,'Only active reserved bookings can be invoiced');
      if(!b.acquisition_voucher_id||!b.purchase_cost_paisa)fail(409,'Vehicle is uncosted legacy stock; account for its acquisition first');
      const exist=await db.query('SELECT id FROM vehicle_sales_invoices WHERE company_id=$1 AND booking_id=$2',[company,b.id]);
      if(exist.rowCount)fail(409,'Booking already invoiced');
      const amount=Number(b.agreed_price_paisa),cost=Number(b.purchase_cost_paisa);
      if(!Number.isSafeInteger(amount)||!Number.isSafeInteger(cost))fail(409,'Amounts exceed safe range');
      const gl=await accounts(db,['1020301001','4010301001','5010401001','1020501001']);
      const reference=await nextDoc(db,'VI',input.date);
      const revenue=await journal(db,{date:input.date,departmentCode:'SALES',narrative:'Vehicle sales invoice '+reference,
        debit:gl.get('1020301001'),credit:gl.get('4010301001'),value:amount});
      const cogs=await journal(db,{date:input.date,departmentCode:'SALES',narrative:'Vehicle COGS '+reference,
        debit:gl.get('5010401001'),credit:gl.get('1020501001'),value:cost});
      const invoice=await db.query(
        'INSERT INTO vehicle_sales_invoices(company_id,reference,booking_id,customer_id,vehicle_id,invoice_date,due_date,sales_amount_paisa,cogs_paisa,revenue_voucher_id,cogs_voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,reference',
        [company,reference,b.id,b.customer_id,b.vehicle_id,input.date,input.dueDate,amount,cost,revenue.id,cogs.id,actor]);
      await db.query("UPDATE vehicle_stock SET status='SOLD' WHERE company_id=$1 AND id=$2",[company,b.vehicle_id]);
      await audit(db,'VEHICLE_INVOICE_POSTED',invoice.rows[0].id,{reference,booking:b.booking_ref,revenue:revenue.number,cogs:cogs.number});
      return {...invoice.rows[0],revenue_journal:revenue.number,cogs_journal:cogs.number};
    });
    send(res,201,sale);return true;
  }

  const salesPayment=/^\/api\/finance4\/sales-invoices\/([a-f0-9-]{36})\/payments$/i.exec(path);
  if(salesPayment&&post){
    mustFinance();checkUuid(salesPayment[1],fail,'Sales invoice');
    const input=await read(x=>({amount:paisaField(x.amount,'Collection'),date:dateField(x.date,'Collection date'),
      clientKey:checkUuid(x.clientKey,fail,'Idempotency key')}));
    const result=await tx(pool,async db=>{
      const r=await db.query('SELECT id,reference,sales_amount_paisa::text,paid_paisa::text FROM vehicle_sales_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,salesPayment[1]]);
      if(!r.rowCount)fail(404,'Sales invoice not found');
      const inv=r.rows[0];
      if(BigInt(input.amount)>BigInt(inv.sales_amount_paisa)-BigInt(inv.paid_paisa))fail(409,'Collection exceeds outstanding sale amount');
      const gl=await accounts(db,['1020402001','1020301001']);
      const ledger=await journal(db,{type:'BB/R',date:input.date,departmentCode:'FINANCE',
        narrative:'Vehicle invoice collection '+inv.reference,
        debit:gl.get('1020402001'),credit:gl.get('1020301001'),value:input.amount});
      const pay=await db.query('INSERT INTO vehicle_sales_payments(company_id,invoice_id,payment_date,amount_paisa,client_key,voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [company,inv.id,input.date,input.amount,input.clientKey,ledger.id,actor]);
      await db.query('UPDATE vehicle_sales_invoices SET paid_paisa=paid_paisa+$1 WHERE company_id=$2 AND id=$3',[input.amount,company,inv.id]);
      await audit(db,'VEHICLE_INVOICE_COLLECTION',pay.rows[0].id,{invoiceId:inv.id,journal:ledger.number});
      return {paymentId:pay.rows[0].id,journal:ledger.number};
    });
    send(res,201,result);return true;
  }
  if(path==='/api/reports/reconciliation'&&get){
    mustFinance();
    const r=await pool.query(
      "SELECT a.code,coalesce(sum(CASE WHEN v.id IS NOT NULL THEN l.debit_paisa-l.credit_paisa ELSE 0 END),0)::text AS balance FROM accounts a LEFT JOIN voucher_lines l ON l.account_id=a.id AND l.company_id=a.company_id LEFT JOIN vouchers v ON v.id=l.voucher_id AND v.company_id=a.company_id AND v.status='POSTED' WHERE a.company_id=$1 AND a.code=ANY($2::text[]) GROUP BY a.code",
      [company,['1020301001','2010101001','1020501001','1020601001']]);
    const gl=new Map(r.rows.map(x=>[x.code,BigInt(x.balance)]));
    const sum=async sql=>{
      const result=await pool.query(sql,[company]);
      return BigInt(result.rows[0].total);
    };
    const arService=await sum('SELECT coalesce(sum(labor_amount_paisa-paid_paisa),0)::text AS total FROM service_invoices WHERE company_id=$1');
    const arVehicle=await sum('SELECT coalesce(sum(sales_amount_paisa-paid_paisa),0)::text AS total FROM vehicle_sales_invoices WHERE company_id=$1');
    const ap=await sum('SELECT coalesce(sum(amount_paisa-paid_paisa),0)::text AS total FROM purchase_bills WHERE company_id=$1');
    const vin=await sum("SELECT coalesce(sum(purchase_cost_paisa),0)::text AS total FROM vehicle_stock WHERE company_id=$1 AND status IN ('IN_STOCK','RESERVED') AND acquisition_voucher_id IS NOT NULL");
    const parts=await sum("SELECT coalesce(sum(inventory_value_paisa),0)::text AS total FROM parts WHERE company_id=$1 AND valuation_mode='POSTED'");
    const legacyVehicles=await pool.query("SELECT count(*)::int AS total FROM vehicle_stock WHERE company_id=$1 AND acquisition_voucher_id IS NULL AND status IN ('IN_STOCK','RESERVED')",[company]);
    const legacyParts=await pool.query("SELECT count(*)::int AS total FROM parts p WHERE p.company_id=$1 AND p.valuation_mode='LEGACY' AND (p.stock_qty>0 OR EXISTS(SELECT 1 FROM stock_movements m WHERE m.company_id=p.company_id AND m.part_id=p.id))",[company]);
    const checks=[
      {name:'Accounts Receivable',glCode:'1020301001',expected:arService+arVehicle,actual:gl.get('1020301001')||0n},
      {name:'Accounts Payable',glCode:'2010101001',expected:-ap,actual:gl.get('2010101001')||0n},
      {name:'Vehicle Inventory',glCode:'1020501001',expected:vin,actual:gl.get('1020501001')||0n},
      {name:'Parts Inventory',glCode:'1020601001',expected:parts,actual:gl.get('1020601001')||0n}
    ].map(x=>({name:x.name,gl_account:x.glCode,expected_paisa:x.expected.toString(),gl_paisa:x.actual.toString(),
      difference_paisa:(x.actual-x.expected).toString(),matched:x.actual===x.expected}));
    const unresolved_legacy={vehicles:legacyVehicles.rows[0].total,parts:legacyParts.rows[0].total};
    const reconciled=checks.every(x=>x.matched)&&unresolved_legacy.vehicles===0&&unresolved_legacy.parts===0;
    send(res,200,{reconciled,checks,unresolved_legacy,
      note:'Current posted balances only; any manual GL control-account journals will be reported as differences. Legacy stock remains unvalued until migrated.'});
    return true;
  }
  return false;
}

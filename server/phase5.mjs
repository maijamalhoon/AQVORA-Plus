import {dateField,optionalString,paisaField,quantityField,stringField,uuidPattern} from './automotive-rules.mjs';
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const idValue=(x,fail,name='ID')=>{if(typeof x!=='string'||!uuidPattern.test(x))fail(400,name+' invalid');return x;};
const valid=async(readJson,fail,fn)=>{
 const body=await readJson();
 try{return fn(body||{});}catch(e){if(e?.status)throw e;fail(400,e.message);}
};
const positive=(n,fail)=>{const value=BigInt(n);if(value<=0n||value>MAX)fail(409,'Invalid or unsafe posting amount');return value;};
const money=(x,fail)=>positive(x,fail).toString();
export async function handlePhase5Api({req,res,pool,ctx,path,send,fail,readJson,tx,postExisting,openPeriod}){
 if(!path.startsWith('/api/phase5/'))return false;
 const company=ctx.selected.company_id,actor=ctx.user.id,role=ctx.selected.role;
 const get=req.method==='GET',post=req.method==='POST';
 const finance=()=>{if(!['ADMIN','FINANCE'].includes(role))fail(403,'Finance permission required');};
 const sales=()=>{if(!['ADMIN','SALES'].includes(role))fail(403,'Sales permission required');};
 const salesRead=()=>{if(!['ADMIN','FINANCE','SALES'].includes(role))fail(403,'Sales access required');};
 const taxRead=()=>{if(!['ADMIN','FINANCE','SALES'].includes(role))fail(403,'Tax code access denied');};
 const input=fn=>valid(()=>readJson(req),fail,fn);
 const audit=(db,action,entity,meta={})=>db.query(
   'INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',
   [company,actor,action,entity,JSON.stringify(meta)]);
 const nextDoc=async(db,kind,date)=>{
   const r=await db.query('INSERT INTO document_sequences(company_id,code,period,last_number) VALUES($1,$2,$3,1) ON CONFLICT(company_id,code,period) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number',
     [company,kind,date.slice(0,7)]);
   if(r.rows[0].last_number>999999)fail(409,'Document sequence exhausted');
   return kind+'/'+date.slice(2,4)+date.slice(5,7)+String(r.rows[0].last_number).padStart(6,'0');
 };
 const journal=async(db,{date,area='FINANCE',narrative,type='JV',lines})=>{
   await openPeriod(db,company,date);
   if(lines.length<2||lines.length>10)fail(400,'Invalid accounting lines');
   let debit=0n,credit=0n;
   const normalized=lines.map((l)=>{
     const dr=BigInt(l.debit||0),cr=BigInt(l.credit||0);
     if((dr>0n)===(cr>0n)||dr<0n||cr<0n||dr>MAX||cr>MAX)fail(400,'Each posting line needs one positive debit or credit');
     debit+=dr;credit+=cr;
     return {code:l.code,dr,cr};
   });
   if(debit===0n||debit!==credit||debit>MAX)fail(409,'Unbalanced or unsafe financial posting');
   const codes=[...new Set(normalized.map(l=>l.code))];
   const [a,d]=await Promise.all([
     db.query('SELECT id,code FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]),
     db.query('SELECT id FROM departments WHERE company_id=$1 AND code=$2',[company,area])
   ]);
   if(a.rowCount!==codes.length||!d.rowCount)fail(409,'Missing active control account or department');
   const ids=new Map(a.rows.map(row=>[row.code,row.id]));
   const v=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
     [company,d.rows[0].id,type,date,narrative,actor]);
   const voucher=v.rows[0].id;
   for(const [i,l] of normalized.entries()){
     await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,$4,$5,$6)',
       [company,voucher,ids.get(l.code),i+1,l.dr.toString(),l.cr.toString()]);
   }
   const number=await postExisting(db,ctx,{id:voucher,status:'DRAFT',voucher_type:type,voucher_date:date});
   return {id:voucher,number};
 };

 if(path==='/api/phase5/tax-codes'&&get){
   taxRead();const r=await pool.query('SELECT id,code,name,rate_bps FROM tax_codes WHERE company_id=$1 ORDER BY code',[company]);
   send(res,200,{codes:r.rows});return true;
 }
 if(path==='/api/phase5/tax-codes'&&post){
   if(role!=='ADMIN')fail(403,'Only Admin may register tax codes');
   const d=await input(x=>{
     const rate=Number(x.rateBps);
     if(!Number.isInteger(rate)||rate<0||rate>10000)throw Error('Rate must be an integer number of basis points between 0 and 10000');
     const code=stringField(x.code,'Tax code',40).toUpperCase();
     if(!/^[A-Z0-9_-]+$/.test(code))throw Error('Tax code may contain letters, digits, underscores and hyphens');
     return {code,name:stringField(x.name,'Tax description'),rate};
   });
   const created=await tx(pool,async db=>{
     const r=await db.query('INSERT INTO tax_codes(company_id,code,name,rate_bps,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,code,rate_bps',
       [company,d.code,d.name,d.rate,actor]);
     await audit(db,'TAX_CODE_CREATED',r.rows[0].id,{code:d.code,rateBps:d.rate});
     return r.rows[0];
   });
   send(res,201,created);return true;
 }
 if(path==='/api/phase5/purchase-returns'&&get){
   finance();
   const r=await pool.query(
     'SELECT r.id,r.reference,r.return_date::text,r.quantity,r.supplier_credit_paisa::text,r.inventory_cost_paisa::text,r.variance_paisa::text,r.reason,b.reference AS bill_reference,p.sku FROM purchase_returns r JOIN purchase_bills b ON b.company_id=r.company_id AND b.id=r.bill_id JOIN parts p ON p.company_id=r.company_id AND p.id=r.part_id WHERE r.company_id=$1 ORDER BY r.created_at DESC LIMIT 200',[company]);
   send(res,200,{returns:r.rows});return true;
 }
 if(path==='/api/phase5/purchase-returns'&&post){
   finance();
   const d=await input(x=>({billId:idValue(x.billId,fail,'Supplier bill'),quantity:quantityField(x.quantity),
     date:dateField(x.date,'Return date'),reason:stringField(x.reason,'Return reason',2000,3),
     clientKey:idValue(x.clientKey,fail,'Idempotency key')}));
   const result=await tx(pool,async db=>{
     const bill=(await db.query(
       'SELECT id,reference,bill_type,part_id,quantity,returned_qty,amount_paisa::text,paid_paisa::text,credited_paisa::text,invoice_date::text FROM purchase_bills WHERE company_id=$1 AND id=$2 FOR UPDATE',
       [company,d.billId])).rows[0];
     if(!bill)fail(404,'Supplier bill not found');
     if(bill.bill_type!=='PARTS')fail(409,'Only accounted parts bills support vendor returns');
     if(d.date<bill.invoice_date)fail(409,'Return predates vendor invoice');
     if(d.quantity>bill.quantity-bill.returned_qty)fail(409,'Return quantity exceeds unreturned purchase quantity');
     const p=(await db.query(
       'SELECT id,stock_qty,inventory_value_paisa::text,valuation_mode FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',
       [company,bill.part_id])).rows[0];
     if(!p||p.valuation_mode!=='POSTED')fail(409,'Part is not accounted stock');
     if(d.quantity>p.stock_qty)fail(409,'Insufficient parts on hand for return');
     const credit=BigInt(bill.amount_paisa)*BigInt(d.quantity)/BigInt(bill.quantity);
     if(credit>BigInt(bill.amount_paisa)-BigInt(bill.credited_paisa)-BigInt(bill.paid_paisa))
       fail(409,'Supplier return exceeds remaining unpaid balance; refunds not yet implemented');
     positive(credit,fail);
     const total=BigInt(p.inventory_value_paisa),onHand=BigInt(p.stock_qty),units=BigInt(d.quantity);
     const carrying=units===onHand?total:(total*units+onHand/2n)/onHand;
     positive(carrying,fail);
     const variance=credit-carrying;
     const reference=await nextDoc(db,'PR',d.date);
     const entries=[{code:'2010101001',debit:credit},{code:'1020601001',credit:carrying}];
     if(variance>0n)entries.push({code:'5010601001',credit:variance});
     if(variance<0n)entries.push({code:'5010601001',debit:-variance});
     const v=await journal(db,{date:d.date,area:'PARTS',narrative:'Supplier parts return '+reference+' / '+d.reason,lines:entries});
     const r=await db.query(
       'INSERT INTO purchase_returns(company_id,reference,bill_id,part_id,quantity,supplier_credit_paisa,inventory_cost_paisa,variance_paisa,voucher_id,client_key,return_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,reference',
       [company,reference,bill.id,p.id,d.quantity,credit.toString(),carrying.toString(),variance.toString(),v.id,d.clientKey,d.date,d.reason,actor]);
     await db.query(
       "INSERT INTO stock_movements(company_id,part_id,direction,quantity,unit_cost_paisa,reference,job_id,created_by,accounting_voucher_id,cost_total_paisa) VALUES($1,$2,'RETURN',$3,$4,$5,NULL,$6,$7,$8)",
       [company,p.id,d.quantity,((carrying+units/2n)/units).toString(),reference,actor,v.id,carrying.toString()]);
     const remainQty=p.stock_qty-d.quantity,remaining=total-carrying;
     const avg=remainQty?(remaining+BigInt(remainQty)/2n)/BigInt(remainQty):0n;
     await db.query('UPDATE parts SET stock_qty=$1,inventory_value_paisa=$2,unit_cost_paisa=$3 WHERE company_id=$4 AND id=$5',
       [remainQty,remaining.toString(),avg.toString(),company,p.id]);
     await db.query('UPDATE purchase_bills SET returned_qty=returned_qty+$1,credited_paisa=credited_paisa+$2 WHERE company_id=$3 AND id=$4',
       [d.quantity,credit.toString(),company,bill.id]);
     await audit(db,'SUPPLIER_PARTS_RETURN',r.rows[0].id,{reference,journal:v.number,amountPaisa:credit.toString()});
     return {...r.rows[0],journal:v.number,supplier_credit_paisa:credit.toString()};
   });
   send(res,201,result);return true;
 }
 if(path==='/api/phase5/credit-notes'&&get){
   finance();
   const r=await pool.query(
     'SELECT n.id,n.reference,n.issued_on::text,n.net_paisa::text,n.tax_paisa::text,n.reason,i.reference AS invoice_reference FROM vehicle_credit_notes n JOIN vehicle_sales_invoices i ON i.company_id=n.company_id AND i.id=n.invoice_id WHERE n.company_id=$1 ORDER BY n.created_at DESC LIMIT 200',[company]);
   send(res,200,{notes:r.rows});return true;
 }
 if(path==='/api/phase5/credit-notes'&&post){
   finance();
   const d=await input(x=>({invoiceId:idValue(x.invoiceId,fail,'Vehicle invoice'),
     net:paisaField(x.netAmount,'Net credit amount'),date:dateField(x.date,'Credit date'),
     reason:stringField(x.reason,'Credit note reason',2000,3),clientKey:idValue(x.clientKey,fail,'Idempotency key')}));
   const result=await tx(pool,async db=>{
     const inv=(await db.query(
       'SELECT id,reference,invoice_date::text,sales_amount_paisa::text,sales_tax_paisa::text,credited_net_paisa::text,credited_tax_paisa::text,gross_amount_paisa::text,paid_paisa::text,tax_rate_bps FROM vehicle_sales_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE',
       [company,d.invoiceId])).rows[0];
     if(!inv)fail(404,'Sales invoice not found');
     if(d.date<inv.invoice_date)fail(409,'Credit note predates invoice');
     const remainingNet=BigInt(inv.sales_amount_paisa)-BigInt(inv.credited_net_paisa),net=BigInt(d.net);
     if(net>remainingNet)fail(409,'Credit exceeds remaining net invoice amount');
     const remainingTax=BigInt(inv.sales_tax_paisa)-BigInt(inv.credited_tax_paisa);
     let tax=net===remainingNet?remainingTax:(net*BigInt(inv.tax_rate_bps)+5000n)/10000n;
     if(tax>remainingTax)tax=remainingTax;
     const outstanding=BigInt(inv.gross_amount_paisa)-BigInt(inv.paid_paisa)-BigInt(inv.credited_net_paisa)-BigInt(inv.credited_tax_paisa);
     if(net+tax>outstanding)fail(409,'Credit exceeds unpaid balance; customer refund workflow required');
     const reference=await nextDoc(db,'CN',d.date);
     const revenue=await journal(db,{date:d.date,area:'FINANCE',
       narrative:'Vehicle price adjustment '+reference+' / '+d.reason,
       lines:[{code:'4010301001',debit:net},{code:'1020301001',credit:net}]});
     let taxVoucher=null;
     if(tax>0n)taxVoucher=await journal(db,{date:d.date,area:'FINANCE',narrative:'Tax reduction '+reference,
       lines:[{code:'2010201001',debit:tax},{code:'1020301001',credit:tax}]});
     const r=await db.query(
       'INSERT INTO vehicle_credit_notes(company_id,reference,invoice_id,net_paisa,tax_paisa,revenue_voucher_id,tax_voucher_id,client_key,issued_on,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,reference',
       [company,reference,inv.id,net.toString(),tax.toString(),revenue.id,taxVoucher?.id||null,d.clientKey,d.date,d.reason,actor]);
     await db.query('UPDATE vehicle_sales_invoices SET credited_net_paisa=credited_net_paisa+$1,credited_tax_paisa=credited_tax_paisa+$2 WHERE company_id=$3 AND id=$4',
       [net.toString(),tax.toString(),company,inv.id]);
     await audit(db,'VEHICLE_PRICE_CREDIT_NOTE',r.rows[0].id,{invoice:inv.reference,reference,revenueJournal:revenue.number,taxJournal:taxVoucher?.number||null});
     return {...r.rows[0],net_paisa:net.toString(),tax_paisa:tax.toString()};
   });
   send(res,201,result);return true;
 }
 if(path==='/api/phase5/deliveries'&&get){
   salesRead();
   const r=await pool.query(
     'SELECT d.id,d.reference,d.delivered_on::text,d.recipient,d.odometer_km,i.reference AS invoice_reference,c.name AS customer_name,v.chassis FROM vehicle_deliveries d JOIN vehicle_sales_invoices i ON i.company_id=d.company_id AND i.id=d.invoice_id JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id JOIN vehicle_stock v ON v.company_id=i.company_id AND v.id=i.vehicle_id WHERE d.company_id=$1 ORDER BY d.created_at DESC LIMIT 200',[company]);
   send(res,200,{deliveries:r.rows});return true;
 }
 if(path==='/api/phase5/deliveries'&&post){
   sales();
   const d=await input(x=>{
     const km=Number(x.odometerKm);
     if(!Number.isInteger(km)||km<0||km>1000000)throw Error('Odometer must be a whole number between 0 and 1,000,000');
     return {invoiceId:idValue(x.invoiceId,fail,'Vehicle invoice'),date:dateField(x.date,'Delivery date'),
       recipient:stringField(x.recipient,'Recipient name'),km,notes:optionalString(x.notes,'Notes',2000)};
   });
   const result=await tx(pool,async db=>{
     const inv=(await db.query(
       'SELECT id,reference,invoice_date::text,sales_amount_paisa::text,credited_net_paisa::text,gross_amount_paisa::text,paid_paisa::text,credited_tax_paisa::text FROM vehicle_sales_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE',
       [company,d.invoiceId])).rows[0];
     if(!inv)fail(404,'Sales invoice not found');
     if(d.date<inv.invoice_date)fail(409,'Delivery predates invoice');
     const unpaid=BigInt(inv.gross_amount_paisa)-BigInt(inv.paid_paisa)-BigInt(inv.credited_net_paisa)-BigInt(inv.credited_tax_paisa);
     if(unpaid!==0n)fail(409,'Delivery requires fully settled invoice');
     if(BigInt(inv.sales_amount_paisa)===BigInt(inv.credited_net_paisa))fail(409,'Fully credited invoices cannot be delivered');
     const prior=await db.query('SELECT id FROM vehicle_deliveries WHERE company_id=$1 AND invoice_id=$2',[company,inv.id]);
     if(prior.rowCount)fail(409,'Vehicle already delivered');
     const reference=await nextDoc(db,'DL',d.date);
     const r=await db.query(
       'INSERT INTO vehicle_deliveries(company_id,reference,invoice_id,delivered_on,recipient,odometer_km,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,reference',
       [company,reference,inv.id,d.date,d.recipient,d.km,d.notes,actor]);
     await audit(db,'VEHICLE_DELIVERED',r.rows[0].id,{invoice:inv.reference,reference});
     return r.rows[0];
   });
   send(res,201,result);return true;
 }
 if(path==='/api/phase5/reports/ap-aging'&&get){
   finance();
   const r=await pool.query(
     "SELECT b.reference,b.due_date::text,s.name AS supplier_name,b.bill_type,(b.amount_paisa-b.credited_paisa-b.paid_paisa+b.refunded_paisa)::text AS outstanding_paisa,GREATEST(0,CURRENT_DATE-b.due_date) AS days_overdue FROM purchase_bills b JOIN suppliers s ON s.company_id=b.company_id AND s.id=b.supplier_id WHERE b.company_id=$1 AND b.amount_paisa+b.refunded_paisa>b.credited_paisa+b.paid_paisa ORDER BY b.due_date,b.reference LIMIT 500",
     [company]);
   send(res,200,{rows:r.rows,scope:'CURRENT_OUTSTANDING_ONLY'});return true;
 }
 if(path==='/api/phase5/reports/tax-summary'&&get){
   finance();
   const invoices=await pool.query(
     "SELECT coalesce(sum(sales_tax_paisa),0)::text AS issued_paisa,coalesce(sum(credited_tax_paisa),0)::text AS credited_paisa FROM vehicle_sales_invoices WHERE company_id=$1",[company]);
   const gl=await pool.query(
     "SELECT coalesce(sum(CASE WHEN v.id IS NOT NULL THEN l.credit_paisa-l.debit_paisa ELSE 0 END),0)::text AS posted_paisa FROM accounts a LEFT JOIN voucher_lines l ON l.account_id=a.id AND l.company_id=a.company_id LEFT JOIN vouchers v ON v.company_id=a.company_id AND v.id=l.voucher_id AND v.status='POSTED' WHERE a.company_id=$1 AND a.code='2010201001'",[company]);
   const data=invoices.rows[0],expected=BigInt(data.issued_paisa)-BigInt(data.credited_paisa);
   const actual=BigInt(gl.rows[0].posted_paisa);
   send(res,200,{issued_paisa:data.issued_paisa,credited_paisa:data.credited_paisa,
     net_paisa:expected.toString(),gl_paisa:actual.toString(),difference_paisa:(actual-expected).toString(),reconciled:actual===expected,
     note:'Configured tax accrual only; does not represent a statutory tax filing or tax payable after remittances.'});return true;
 }
 if(path==='/api/phase5/reports/sales-margin'&&get){
   salesRead();
   const r=await pool.query(
     "SELECT i.reference,c.name AS customer_name,i.invoice_date::text,i.sales_amount_paisa::text,i.sales_tax_paisa::text,i.credited_net_paisa::text,i.cogs_paisa::text,(i.sales_amount_paisa-i.credited_net_paisa-i.cogs_paisa)::text AS gross_margin_paisa,(d.id IS NOT NULL) AS delivered FROM vehicle_sales_invoices i JOIN customers c ON c.company_id=i.company_id AND c.id=i.customer_id LEFT JOIN vehicle_deliveries d ON d.company_id=i.company_id AND d.invoice_id=i.id WHERE i.company_id=$1 ORDER BY i.invoice_date DESC,i.reference DESC LIMIT 200",[company]);
   const totals=await pool.query(
     "SELECT coalesce(sum(sales_amount_paisa-credited_net_paisa),0)::text AS net_sales_paisa,coalesce(sum(cogs_paisa),0)::text AS cogs_paisa,coalesce(sum(sales_amount_paisa-credited_net_paisa-cogs_paisa),0)::text AS gross_margin_paisa,count(*)::int AS invoices FROM vehicle_sales_invoices WHERE company_id=$1",[company]);
   send(res,200,{rows:r.rows,totals:totals.rows[0],list_limit:200});return true;
 }
 return false;
}

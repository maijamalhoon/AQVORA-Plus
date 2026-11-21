import {dateField,paisaField,quantityField,stringField,uuidPattern} from './automotive-rules.mjs';
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const uuid=(value,fail,label='Identifier')=>{
 if(typeof value!=='string'||!uuidPattern.test(value))fail(400,label+' invalid');
 return value;
};
const body=async(readJson,fail,fn)=>{
 const b=await readJson();
 try{return fn(b||{});}catch(e){if(e.status)throw e;fail(400,e.message);}
};
export async function handlePhase7Api({req,res,pool,ctx,path,send,fail,readJson,tx,postExisting,openPeriod}){
 if(!path.startsWith('/api/phase7/'))return false;
 const company=ctx.selected.company_id,actor=ctx.user.id,role=ctx.selected.role;
 const isGet=req.method==='GET',isPost=req.method==='POST';
 const fin=()=>{if(role!=='FINANCE')fail(403,'Only Finance may request or record supplier bank refunds');};
 const adm=()=>{if(role!=='ADMIN')fail(403,'Only an independent Admin may approve and set refund limits');};
 const readable=()=>{if(!['FINANCE','ADMIN'].includes(role))fail(403,'Finance or Admin role required');};
 const parse=fn=>body(()=>readJson(req),fail,fn);
 const audit=(db,action,entity,meta={})=>db.query(
  'INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',
  [company,actor,action,entity,JSON.stringify(meta)]);
 const policy=async(db,locked=false)=>{
  const p=await db.query('SELECT max_single_refund_paisa::text FROM supplier_refund_policies WHERE company_id=$1'+(locked?' FOR UPDATE':''),[company]);
  if(!p.rowCount)fail(409,'Admin must configure a supplier refund limit first');
  return BigInt(p.rows[0].max_single_refund_paisa);
 };
 const ensureSafe=x=>{if(x<=0n||x>MAX)fail(409,'Amount exceeds safe positive PKR range');return x;};
 const journal=async(db,{date,narrative,type='JV',lines})=>{
  if(lines.length<2||lines.length>3)fail(400,'Invalid journal line count');
  await openPeriod(db,company,date);
  const dept=await db.query("SELECT id FROM departments WHERE company_id=$1 AND code='FINANCE'",[company]);
  if(!dept.rowCount)fail(409,'Finance department missing');
  const codes=[...new Set(lines.map(l=>l.code))];
  const a=await db.query('SELECT id,code FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]);
  if(a.rowCount!==codes.length)fail(409,'Required active company GL control account missing');
  const mapped=new Map(a.rows.map(r=>[r.code,r.id]));
  let dr=0n,cr=0n;
  for(const x of lines){
   const debit=BigInt(x.debit||0),credit=BigInt(x.credit||0);
   if((debit>0n)===(credit>0n)||debit<0n||credit<0n||debit>MAX||credit>MAX)fail(400,'Each journal line needs exactly one positive amount');
   dr+=debit;cr+=credit;
  }
  if(dr===0n||dr!==cr||dr>MAX)fail(409,'Unbalanced or unsafe journal');
  const v=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [company,dept.rows[0].id,type,date,narrative,actor]);
  for(const [i,line] of lines.entries())await db.query(
    'INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,$4,$5,$6)',
    [company,v.rows[0].id,mapped.get(line.code),i+1,String(line.debit||0),String(line.credit||0)]);
  const number=await postExisting(db,ctx,{id:v.rows[0].id,status:'DRAFT',voucher_type:type,voucher_date:date});
  return {id:v.rows[0].id,number};
 };
 const nextReturn=async(db,date)=>{
  const r=await db.query("INSERT INTO document_sequences(company_id,code,period,last_number) VALUES($1,'PR',$2,1) ON CONFLICT(company_id,code,period) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number",
    [company,date.slice(0,7)]);
  if(r.rows[0].last_number>999999)fail(409,'Return document sequence exhausted');
  return 'PR/'+date.slice(2,4)+date.slice(5,7)+String(r.rows[0].last_number).padStart(6,'0');
 };
 const billLock=async(db,billId)=>{
  const r=await db.query(
    'SELECT id,reference,part_id,quantity,returned_qty,bill_type,amount_paisa::text,paid_paisa::text,credited_paisa::text,refunded_paisa::text,invoice_date::text FROM purchase_bills WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [company,billId]);
  if(!r.rowCount)fail(404,'Supplier bill not found');
  return r.rows[0];
 };
 const verifyBill=(b,qty,asOf)=>{
  if(b.bill_type!=='PARTS'||!b.part_id)fail(409,'Only parts supplier invoices are eligible');
  if(b.returned_qty!==0||BigInt(b.credited_paisa)!==0n||BigInt(b.refunded_paisa)!==0n)fail(409,'Only fully paid bills without earlier returns are eligible');
  if(BigInt(b.paid_paisa)!==BigInt(b.amount_paisa))fail(409,'Supplier bill must be fully paid before this refund workflow');
  if(asOf<b.invoice_date)fail(409,'Return cannot predate supplier invoice');
  if(qty>b.quantity)fail(409,'Return quantity exceeds original parts bill');
  const credit=BigInt(b.amount_paisa)*BigInt(qty)/BigInt(b.quantity);
  return ensureSafe(credit);
 };
 if(path==='/api/phase7/refund-policy'&&isGet){
  readable();
  const r=await pool.query('SELECT max_single_refund_paisa::text,updated_at FROM supplier_refund_policies WHERE company_id=$1',[company]);
  send(res,200,{policy:r.rows[0]||null});return true;
 }
 if(path==='/api/phase7/refund-policy'&&isPost){
  adm();
  const d=await parse(x=>({amount:BigInt(paisaField(x.maxAmount,'Maximum single supplier refund'))}));
  const result=await tx(pool,async db=>{
   const r=await db.query(
    'INSERT INTO supplier_refund_policies(company_id,max_single_refund_paisa,updated_by) VALUES($1,$2,$3) ON CONFLICT(company_id) DO UPDATE SET max_single_refund_paisa=EXCLUDED.max_single_refund_paisa,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING max_single_refund_paisa::text,updated_at',
    [company,d.amount.toString(),actor]);
   await audit(db,'SUPPLIER_REFUND_LIMIT_CHANGED',company,{maxAmountPaisa:d.amount.toString()});
   return r.rows[0];
  });
  send(res,200,result);return true;
 }
 if(path==='/api/phase7/supplier-refunds'&&isGet){
  readable();
  const r=await pool.query(
   'SELECT q.id,q.bill_id,q.quantity,q.supplier_credit_paisa::text,q.return_date::text,q.reason,q.status,q.requested_by,q.approved_by,q.created_at,q.reviewed_at,q.executed_at,b.reference AS bill_reference,s.name AS supplier_name,u.email AS requester_email,r.email AS reviewer_email,rec.bank_reference FROM supplier_refund_requests q JOIN purchase_bills b ON b.company_id=q.company_id AND b.id=q.bill_id JOIN suppliers s ON s.company_id=b.company_id AND s.id=b.supplier_id JOIN app_users u ON u.id=q.requested_by LEFT JOIN app_users r ON r.id=q.approved_by LEFT JOIN supplier_refund_receipts rec ON rec.company_id=q.company_id AND rec.request_id=q.id WHERE q.company_id=$1 ORDER BY q.created_at DESC LIMIT 200',
   [company]);
  send(res,200,{requests:r.rows});return true;
 }
 if(path==='/api/phase7/supplier-refunds/requests'&&isPost){
  fin();
  const d=await parse(x=>({billId:uuid(x.billId,fail,'Supplier bill'),quantity:quantityField(x.quantity),
    returnDate:dateField(x.returnDate,'Requested return date'),reason:stringField(x.reason,'Refund reason',2000,8),
    clientKey:uuid(x.clientKey,fail,'Idempotency key')}));
  const newRequest=await tx(pool,async db=>{
   const b=await billLock(db,d.billId);
   const credit=verifyBill(b,d.quantity,d.returnDate);
   const max=await policy(db,true);
   if(credit>max)fail(409,'Supplier refund exceeds company approval limit');
   const p=await db.query('SELECT stock_qty,valuation_mode FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,b.part_id]);
   if(!p.rowCount||p.rows[0].valuation_mode!=='POSTED'||p.rows[0].stock_qty<d.quantity)
     fail(409,'Not enough accounted parts on hand for a return');
   const r=await db.query(
    'INSERT INTO supplier_refund_requests(company_id,bill_id,part_id,quantity,supplier_credit_paisa,return_date,reason,client_key,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status',
    [company,b.id,b.part_id,d.quantity,credit.toString(),d.returnDate,d.reason,d.clientKey,actor]);
   await audit(db,'SUPPLIER_REFUND_REQUESTED',r.rows[0].id,{bill:b.reference,creditPaisa:credit.toString()});
   return {...r.rows[0],supplier_credit_paisa:credit.toString()};
  });
  send(res,201,newRequest);return true;
 }
 const review=/^\/api\/phase7\/supplier-refunds\/([a-f0-9-]{36})\/decision$/i.exec(path);
 if(review&&isPost){
  adm();uuid(review[1],fail,'Refund request');
  const d=await parse(x=>{
   if(!['APPROVED','REJECTED'].includes(x.decision))throw Error('Decision must be APPROVED or REJECTED');
   return {decision:x.decision};
  });
  const result=await tx(pool,async db=>{
   const q=await db.query('SELECT id,status,requested_by FROM supplier_refund_requests WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,review[1]]);
   if(!q.rowCount)fail(404,'Refund request not found');
   if(q.rows[0].status!=='PENDING')fail(409,'Refund request already reviewed');
   if(q.rows[0].requested_by===actor)fail(403,'Requester may not approve their own refund');
   const updated=await db.query(
    'UPDATE supplier_refund_requests SET status=$1,approved_by=$2,reviewed_at=now() WHERE company_id=$3 AND id=$4 RETURNING id,status',
    [d.decision,actor,company,q.rows[0].id]);
   await audit(db,d.decision==='APPROVED'?'SUPPLIER_REFUND_APPROVED':'SUPPLIER_REFUND_REJECTED',q.rows[0].id);
   return updated.rows[0];
  });
  send(res,200,result);return true;
 }
 const execute=/^\/api\/phase7\/supplier-refunds\/([a-f0-9-]{36})\/execute$/i.exec(path);
 if(execute&&isPost){
  fin();uuid(execute[1],fail,'Supplier refund request');
  const d=await parse(x=>({receivedDate:dateField(x.receivedDate,'Confirmed bank receipt date'),
     bankReference:stringField(x.bankReference,'Bank receipt reference',120,4)}));
  const result=await tx(pool,async db=>{
   const q=(await db.query(
    'SELECT id,bill_id,part_id,quantity,supplier_credit_paisa::text,return_date::text,reason,client_key,status,approved_by,requested_by FROM supplier_refund_requests WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [company,execute[1]])).rows[0];
   if(!q)fail(404,'Supplier refund request not found');
   if(q.status!=='APPROVED'||!q.approved_by)fail(409,'Independent Admin approval required before bank refund posting');
   if(q.approved_by===actor)fail(403,'Approver cannot record refund receipt');
   if(d.receivedDate<q.return_date)fail(409,'Bank receipt cannot predate requested supplier return date');
   const b=await billLock(db,q.bill_id);
   const credit=verifyBill(b,q.quantity,d.receivedDate);
   if(credit!==BigInt(q.supplier_credit_paisa)||b.part_id!==q.part_id)
     fail(409,'Bill changed since approval; submit a new request');
   const max=await policy(db,true);
   if(credit>max)fail(409,'Refund exceeds current company approval limit');
   const part=(await db.query(
    'SELECT id,stock_qty,inventory_value_paisa::text,valuation_mode FROM parts WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [company,q.part_id])).rows[0];
   if(!part||part.valuation_mode!=='POSTED'||part.stock_qty<q.quantity)
     fail(409,'Accounted stock is unavailable for supplier return');
   const onHand=BigInt(part.stock_qty),total=BigInt(part.inventory_value_paisa),qty=BigInt(q.quantity);
   const carrying=qty===onHand?total:(total*qty+onHand/2n)/onHand;
   ensureSafe(carrying);
   const variance=credit-carrying;
   const lines=[{code:'2010101001',debit:credit},{code:'1020601001',credit:carrying}];
   if(variance>0n)lines.push({code:'5010601001',credit:variance});
   if(variance<0n)lines.push({code:'5010601001',debit:-variance});
   const ref=await nextReturn(db,d.receivedDate);
   const returnJournal=await journal(db,{date:d.receivedDate,narrative:'Approved supplier parts return '+ref+' / '+q.reason,lines});
   const bankJournal=await journal(db,{date:d.receivedDate,type:'BB/R',narrative:'Verified supplier refund received '+ref+' / bank reference '+d.bankReference,
      lines:[{code:'1020402001',debit:credit},{code:'2010101001',credit}]});
   const returned=await db.query(
    'INSERT INTO purchase_returns(company_id,reference,bill_id,part_id,quantity,supplier_credit_paisa,inventory_cost_paisa,variance_paisa,voucher_id,client_key,return_date,reason,created_by,supplier_refund_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id',
    [company,ref,b.id,q.part_id,q.quantity,credit.toString(),carrying.toString(),variance.toString(),returnJournal.id,q.client_key,d.receivedDate,q.reason,actor,q.id]);
   await db.query(
    "INSERT INTO stock_movements(company_id,part_id,direction,quantity,unit_cost_paisa,reference,job_id,created_by,accounting_voucher_id,cost_total_paisa) VALUES($1,$2,'RETURN',$3,$4,$5,NULL,$6,$7,$8)",
    [company,q.part_id,q.quantity,((carrying+qty/2n)/qty).toString(),ref,actor,returnJournal.id,carrying.toString()]);
   const remainingQty=part.stock_qty-q.quantity,remainingValue=total-carrying;
   const avg=remainingQty?(remainingValue+BigInt(remainingQty)/2n)/BigInt(remainingQty):0n;
   await db.query('UPDATE parts SET stock_qty=$1,inventory_value_paisa=$2,unit_cost_paisa=$3 WHERE company_id=$4 AND id=$5',
      [remainingQty,remainingValue.toString(),avg.toString(),company,q.part_id]);
   const received=await db.query(
    'INSERT INTO supplier_refund_receipts(company_id,request_id,bill_id,purchase_return_id,refund_date,amount_paisa,bank_reference,voucher_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [company,q.id,b.id,returned.rows[0].id,d.receivedDate,credit.toString(),d.bankReference,bankJournal.id,actor]);
   await db.query('UPDATE purchase_bills SET returned_qty=returned_qty+$1,credited_paisa=credited_paisa+$2,refunded_paisa=refunded_paisa+$2 WHERE company_id=$3 AND id=$4',
     [q.quantity,credit.toString(),company,b.id]);
   await db.query("UPDATE supplier_refund_requests SET status='EXECUTED',executed_at=now() WHERE company_id=$1 AND id=$2",[company,q.id]);
   await audit(db,'APPROVED_SUPPLIER_REFUND_POSTED',q.id,
     {bill:b.reference,returnRef:ref,bankRef:d.bankReference,refundPaisa:credit.toString(),
       returnJournal:returnJournal.number,bankJournal:bankJournal.number});
   return {requestId:q.id,receiptId:received.rows[0].id,returnReference:ref,
     refunded_paisa:credit.toString(),returnJournal:returnJournal.number,bankJournal:bankJournal.number};
  });
  send(res,201,result);return true;
 }
 if(path==='/api/phase7/supplier-refunds/audit'&&isGet){
  readable();
  const q=await pool.query(
   "SELECT count(*) FILTER(WHERE status='PENDING')::int AS pending,count(*) FILTER(WHERE status='APPROVED')::int AS approved,count(*) FILTER(WHERE status='REJECTED')::int AS rejected,count(*) FILTER(WHERE status='EXECUTED')::int AS executed FROM supplier_refund_requests WHERE company_id=$1",
   [company]);
  const r=await pool.query(
   "SELECT count(*)::int AS receipts,coalesce(sum(x.amount_paisa),0)::text AS received_paisa,count(*) FILTER(WHERE v.status<>'POSTED')::int AS unposted_bank_vouchers FROM supplier_refund_receipts x JOIN vouchers v ON v.company_id=x.company_id AND v.id=x.voucher_id WHERE x.company_id=$1",
   [company]);
  const broken=await pool.query(
   "SELECT count(*)::int AS broken_links FROM supplier_refund_requests q LEFT JOIN supplier_refund_receipts r ON r.company_id=q.company_id AND r.request_id=q.id LEFT JOIN purchase_returns p ON p.company_id=q.company_id AND p.supplier_refund_request_id=q.id WHERE q.company_id=$1 AND q.status='EXECUTED' AND (r.id IS NULL OR p.id IS NULL OR r.purchase_return_id IS DISTINCT FROM p.id)",
   [company]);
  const totals=await pool.query(
   'SELECT coalesce(sum(refunded_paisa),0)::text AS purchase_refunded_paisa FROM purchase_bills WHERE company_id=$1',[company]);
  const ok=broken.rows[0].broken_links===0&&r.rows[0].unposted_bank_vouchers===0&&
    r.rows[0].received_paisa===totals.rows[0].purchase_refunded_paisa;
  send(res,200,{...q.rows[0],...r.rows[0],...broken.rows[0],reconciled:ok,
     note:'Refund source and posted GL linkage only; physical bank statement verification must be independent.'});return true;
 }
 return false;
}

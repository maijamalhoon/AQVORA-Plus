import {dateField,paisaField,stringField,uuidPattern} from './automotive-rules.mjs';
const LIMIT=BigInt(Number.MAX_SAFE_INTEGER);
const checkId=(v,fail,label='Identifier')=>{if(typeof v!=='string'||!uuidPattern.test(v))fail(400,label+' is invalid');return v;};
async function requestBody(readJson,fail,parse){
  const value=await readJson();
  try{return parse(value||{});}catch(e){if(e.status)throw e;fail(400,e.message);}
}
function calculateTax(net,rate,remainingNet,remainingTax){
  if(net===remainingNet)return remainingTax;
  const result=(net*BigInt(rate)+5000n)/10000n;
  return result<remainingTax?result:remainingTax;
}

export async function handlePhase6Api({req,res,pool,ctx,path,send,fail,readJson,tx,postExisting,openPeriod}){
  if(!path.startsWith('/api/phase6/'))return false;
  const company=ctx.selected.company_id,actor=ctx.user.id,role=ctx.selected.role;
  const finance=()=>{if(role!=='FINANCE')fail(403,'Finance role required for requesting and executing a refund');};
  const admin=()=>{if(role!=='ADMIN')fail(403,'An independent Admin must review refunds');};
  const canRead=()=>{if(!['ADMIN','FINANCE'].includes(role))fail(403,'Finance or Admin role required');};
  const input=parse=>requestBody(()=>readJson(req),fail,parse);
  const audit=(db,action,entity,meta={})=>db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',
      [company,actor,action,entity,JSON.stringify(meta)]);
  const positive=(n,what)=>{if(n<=0n||n>LIMIT)fail(409,'Invalid or unsafe '+what);return n;};
  const journal=async(db,{date,narrative,type='JV',debitCode,creditCode,amount})=>{
    positive(amount,'posting amount');
    await openPeriod(db,company,date);
    const dept=await db.query("SELECT id FROM departments WHERE company_id=$1 AND code='FINANCE'",[company]);
    if(!dept.rowCount)fail(409,'Finance department does not exist');
    const codes=[debitCode,creditCode];
    if(debitCode===creditCode)fail(409,'Posting requires two distinct accounts');
    const a=await db.query('SELECT code,id FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]);
    if(a.rowCount!==2)fail(409,'Missing required active financial control account');
    const ids=new Map(a.rows.map(r=>[r.code,r.id]));
    const v=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [company,dept.rows[0].id,type,date,narrative,actor]);
    await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,1,$4,0),($1,$2,$5,2,0,$4)',
      [company,v.rows[0].id,ids.get(debitCode),amount.toString(),ids.get(creditCode)]);
    const number=await postExisting(db,ctx,{id:v.rows[0].id,status:'DRAFT',voucher_type:type,voucher_date:date});
    return {id:v.rows[0].id,number};
  };
  const document=async(db,date)=>{
    const r=await db.query(
      "INSERT INTO document_sequences(company_id,code,period,last_number) VALUES($1,'CN',$2,1) ON CONFLICT(company_id,code,period) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number",
      [company,date.slice(0,7)]);
    if(r.rows[0].last_number>999999)fail(409,'Credit note sequence exhausted');
    return 'CN/'+date.slice(2,4)+date.slice(5,7)+String(r.rows[0].last_number).padStart(6,'0');
  };
  const invoiceLock=async(db,id)=>{
    const r=await db.query('SELECT id,reference,invoice_date::text,sales_amount_paisa::text,sales_tax_paisa::text,credited_net_paisa::text,credited_tax_paisa::text,paid_paisa::text,gross_amount_paisa::text,tax_rate_bps FROM vehicle_sales_invoices WHERE company_id=$1 AND id=$2 FOR UPDATE',
      [company,id]);
    if(!r.rowCount)fail(404,'Vehicle invoice not found');
    return r.rows[0];
  };
  const validateAdjustment=(inv,net,refundDate)=>{
    if(refundDate<inv.invoice_date)fail(409,'Refund request predates the original invoice');
    const remainingNet=BigInt(inv.sales_amount_paisa)-BigInt(inv.credited_net_paisa);
    const remainingTax=BigInt(inv.sales_tax_paisa)-BigInt(inv.credited_tax_paisa);
    if(net>=remainingNet)fail(409,'Full vehicle returns require a separate ownership/stock return workflow');
    const tax=calculateTax(net,inv.tax_rate_bps,remainingNet,remainingTax);
    const total=net+tax;
    positive(total,'refund total');
    const received=BigInt(inv.paid_paisa);
    if(received<total)fail(409,'Refund amount exceeds net collected cash; use unpaid-balance credit notes instead');
    return {tax,total};
  };
  if(path==='/api/phase6/refunds'&&req.method==='GET'){
    canRead();
    const result=await pool.query(
      "SELECT r.id,r.invoice_id,r.request_date::text,r.reason,r.credit_net_paisa::text,r.credit_tax_paisa::text,r.refund_amount_paisa::text,r.status,r.created_at,r.requested_by,r.approved_by,r.reviewed_at,r.executed_at,r.credit_note_id,i.reference AS invoice_reference,c.name AS customer_name,requester.email AS requested_by_email,reviewer.email AS approved_by_email FROM vehicle_refund_requests r JOIN vehicle_sales_invoices i ON i.id=r.invoice_id AND i.company_id=r.company_id JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id JOIN app_users requester ON requester.id=r.requested_by LEFT JOIN app_users reviewer ON reviewer.id=r.approved_by WHERE r.company_id=$1 ORDER BY r.created_at DESC LIMIT 200",
      [company]);
    send(res,200,{requests:result.rows});return true;
  }
  if(path==='/api/phase6/refunds/requests'&&req.method==='POST'){
    finance();
    const data=await input(x=>({
      invoiceId:checkId(x.invoiceId,fail,'Vehicle invoice'),
      net:BigInt(paisaField(x.netAmount,'Refund net amount')),
      date:dateField(x.date,'Requested refund date'),
      reason:stringField(x.reason,'Refund reason',2000,8),
      clientKey:checkId(x.clientKey,fail,'Idempotency key')
    }));
    const result=await tx(pool,async db=>{
      const inv=await invoiceLock(db,data.invoiceId);
      const {tax,total}=validateAdjustment(inv,data.net,data.date);
      const newRequest=await db.query(
        'INSERT INTO vehicle_refund_requests(company_id,invoice_id,credit_net_paisa,credit_tax_paisa,refund_amount_paisa,request_date,reason,client_key,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status',
        [company,inv.id,data.net.toString(),tax.toString(),total.toString(),data.date,data.reason,data.clientKey,actor]);
      await audit(db,'REFUND_REQUESTED',newRequest.rows[0].id,{invoice:inv.reference,net_paisa:data.net.toString(),tax_paisa:tax.toString()});
      return {...newRequest.rows[0],refund_amount_paisa:total.toString()};
    });
    send(res,201,result);return true;
  }
  const decision=/^\/api\/phase6\/refunds\/([a-f0-9-]{36})\/decision$/i.exec(path);
  if(decision&&req.method==='POST'){
    admin();checkId(decision[1],fail,'Refund request');
    const data=await input(x=>{
      if(!['APPROVED','REJECTED'].includes(x.decision))throw Error('Decision must be APPROVED or REJECTED');
      return {decision:x.decision};
    });
    const result=await tx(pool,async db=>{
      const r=await db.query('SELECT id,invoice_id,status,requested_by FROM vehicle_refund_requests WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,decision[1]]);
      if(!r.rowCount)fail(404,'Refund request not found');
      const row=r.rows[0];
      if(row.status!=='PENDING')fail(409,'Refund request was already reviewed');
      if(row.requested_by===actor)fail(403,'A requester may not approve or reject their own financial adjustment');
      const updated=await db.query(
        'UPDATE vehicle_refund_requests SET status=$1,approved_by=$2,reviewed_at=now() WHERE company_id=$3 AND id=$4 RETURNING id,status',
        [data.decision,actor,company,row.id]);
      await audit(db,data.decision==='APPROVED'?'REFUND_APPROVED':'REFUND_REJECTED',row.id);
      return updated.rows[0];
    });
    send(res,200,result);return true;
  }
  const execute=/^\/api\/phase6\/refunds\/([a-f0-9-]{36})\/execute$/i.exec(path);
  if(execute&&req.method==='POST'){
    finance();checkId(execute[1],fail,'Refund request');
    const done=await tx(pool,async db=>{
      const reqRow=await db.query(
        'SELECT id,invoice_id,credit_net_paisa::text,credit_tax_paisa::text,refund_amount_paisa::text,request_date::text,reason,client_key,status,approved_by,requested_by FROM vehicle_refund_requests WHERE company_id=$1 AND id=$2 FOR UPDATE',
        [company,execute[1]]);
      if(!reqRow.rowCount)fail(404,'Refund request not found');
      const job=reqRow.rows[0];
      if(job.status!=='APPROVED'||!job.approved_by)fail(409,'Refund must receive independent approval before execution');
      if(job.approved_by===actor)fail(403,'Approver cannot execute the refund');
      const inv=await invoiceLock(db,job.invoice_id);
      const net=BigInt(job.credit_net_paisa),tax=BigInt(job.credit_tax_paisa),total=BigInt(job.refund_amount_paisa);
      const checked=validateAdjustment(inv,net,job.request_date);
      if(checked.tax!==tax||checked.total!==total)fail(409,'Invoice changed since approval; submit a new refund request');
      await openPeriod(db,company,job.request_date);
      // Cash leaves the company: Dr Customer AR / Cr Bank. The follow-on credit
      // note Dr Revenue and Tax Liability / Cr AR clears the newly created AR.
      const refundJournal=await journal(db,{
        date:job.request_date,type:'BB/P',
        narrative:'Approved vehicle price refund '+inv.reference+' / '+job.reason,
        debitCode:'1020301001',creditCode:'1020402001',amount:total
      });
      const refund=await db.query(
        'INSERT INTO vehicle_refund_disbursements(company_id,request_id,invoice_id,amount_paisa,refund_date,voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [company,job.id,inv.id,total.toString(),job.request_date,refundJournal.id,actor]);
      await db.query('UPDATE vehicle_sales_invoices SET paid_paisa=paid_paisa-$1 WHERE company_id=$2 AND id=$3',
        [total.toString(),company,inv.id]);
      const reference=await document(db,job.request_date);
      const revenue=await journal(db,{
        date:job.request_date,
        narrative:'Approved vehicle price credit '+reference,
        debitCode:'4010301001',creditCode:'1020301001',amount:net
      });
      let taxJournal=null;
      if(tax>0n){
        taxJournal=await journal(db,{
          date:job.request_date,
          narrative:'Tax reduction for approved refund '+reference,
          debitCode:'2010201001',creditCode:'1020301001',amount:tax
        });
      }
      const note=await db.query(
        'INSERT INTO vehicle_credit_notes(company_id,reference,invoice_id,net_paisa,tax_paisa,revenue_voucher_id,tax_voucher_id,client_key,issued_on,reason,created_by,refund_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,reference',
        [company,reference,inv.id,net.toString(),tax.toString(),revenue.id,taxJournal?.id||null,job.client_key,job.request_date,job.reason,actor,job.id]);
      await db.query('UPDATE vehicle_sales_invoices SET credited_net_paisa=credited_net_paisa+$1,credited_tax_paisa=credited_tax_paisa+$2 WHERE company_id=$3 AND id=$4',
        [net.toString(),tax.toString(),company,inv.id]);
      await db.query("UPDATE vehicle_refund_requests SET status='EXECUTED',executed_at=now(),credit_note_id=$1 WHERE company_id=$2 AND id=$3",
        [note.rows[0].id,company,job.id]);
      await audit(db,'APPROVED_REFUND_EXECUTED',job.id,{
        invoice:inv.reference,creditNote:reference,refundPaisa:total.toString(),
        paymentJournal:refundJournal.number,revenueJournal:revenue.number,
        taxJournal:taxJournal?.number||null
      });
      return {requestId:job.id,refundId:refund.rows[0].id,creditNote:reference,refund_paisa:total.toString(),journal:refundJournal.number};
    });
    send(res,201,done);return true;
  }
  if(path==='/api/phase6/refunds/audit'&&req.method==='GET'){
    canRead();
    const summary=await pool.query(
      "SELECT count(*) FILTER(WHERE status='PENDING')::int AS pending,count(*) FILTER(WHERE status='APPROVED')::int AS approved,count(*) FILTER(WHERE status='REJECTED')::int AS rejected,count(*) FILTER(WHERE status='EXECUTED')::int AS executed FROM vehicle_refund_requests WHERE company_id=$1",
      [company]);
    const payments=await pool.query(
      "SELECT coalesce(sum(r.amount_paisa),0)::text AS paid_out_paisa,count(*)::int AS refund_count,count(*) FILTER(WHERE v.status<>'POSTED')::int AS unposted_refund_vouchers FROM vehicle_refund_disbursements r JOIN vouchers v ON v.id=r.voucher_id AND v.company_id=r.company_id WHERE r.company_id=$1",[company]);
    const unmatched=await pool.query(
      "SELECT count(*)::int AS broken_links FROM vehicle_refund_requests q LEFT JOIN vehicle_refund_disbursements r ON r.company_id=q.company_id AND r.request_id=q.id LEFT JOIN vehicle_credit_notes c ON c.company_id=q.company_id AND c.id=q.credit_note_id WHERE q.company_id=$1 AND q.status='EXECUTED' AND (r.id IS NULL OR c.id IS NULL OR c.refund_request_id IS DISTINCT FROM q.id)",[company]);
    send(res,200,{...summary.rows[0],...payments.rows[0],...unmatched.rows[0],
      reconciled:payments.rows[0].unposted_refund_vouchers===0&&unmatched.rows[0].broken_links===0,
      note:'Operational refund audit, not bank statement reconciliation or legal approval certification.'});
    return true;
  }
  return false;
}

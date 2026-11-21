import {validDate} from './logic.mjs';
import {stringField,uuidPattern} from './automotive-rules.mjs';

// Bank statement sign convention: + credit/inflow, - debit/outflow.
// No journal entries are created by any BRS operation.
const MAX=9007199254740991n;
const money=(raw,{zero=false}={})=>{
 if(typeof raw!=='string'||!/^(-?)(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.test(raw.trim()))
   throw Error('Money must be a signed decimal string with at most two places');
 const v=raw.trim(),neg=v.startsWith('-'),digits=neg?v.slice(1):v;
 const [whole,decimal='']=digits.split('.');
 const result=(BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0')||'0'))*(neg?-1n:1n);
 if(result>MAX||result< -MAX||(!zero&&result===0n))throw Error('Invalid or unsafe bank amount');
 return result;
};
const requiredId=(s,label)=>{if(typeof s!=='string'||!uuidPattern.test(s))throw Error(label+' must be a UUID');return s;};
const validBankDate=(s,label)=>{if(!validDate(s))throw Error(label+' must be valid YYYY-MM-DD');return s;};
const dayAfter=s=>new Date(Date.parse(s+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const asPaisa=v=>BigInt(v||0);

export async function handleBankReconciliationApi({req,res,pool,ctx,path,send,fail,readJson,tx}){
 if(!path.startsWith('/api/brs/'))return false;
 const company=ctx.selected.company_id,user=ctx.user.id,role=ctx.selected.role;
 const canRead=()=>{if(!['ADMIN','FINANCE'].includes(role))fail(403,'Bank reconciliation access requires Finance or Admin');};
 const maker=()=>{if(role!=='FINANCE')fail(403,'Finance must import or match bank entries');};
 const checker=()=>{if(role!=='ADMIN')fail(403,'An independent Admin must approve the reconciliation');};
 const parse=async fn=>{
  const raw=await readJson(req);
  try{return fn(raw);}catch(e){if(e.status)throw e;fail(400,e.message);}
 };
 const audit=(db,action,id,details={})=>db.query(
  'INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',
  [company,user,action,id,JSON.stringify(details)]
 );
 const bankAccount=async db=>{
  const r=await db.query(
   "SELECT id,code,name FROM accounts WHERE company_id=$1 AND code='1020402001' AND kind='ASSET' AND active=true",
   [company]);
  if(!r.rowCount)fail(409,'The active Bank control account 1020402001 is missing');
  return r.rows[0];
 };
 const getBatch=async(db,id,lock=false)=>{
  const q=await db.query(
   'SELECT b.id,b.account_id,b.statement_reference,b.starts_on::text,b.ends_on::text,b.opening_paisa::text,b.closing_paisa::text,b.status,b.imported_by,b.reviewed_by,b.reviewed_at,b.imported_at,a.code AS account_code,a.name AS account_name FROM brs_batches b JOIN accounts a ON a.company_id=b.company_id AND a.id=b.account_id WHERE b.company_id=$1 AND b.id=$2'+(lock?' FOR UPDATE OF b':''),
   [company,id]);
  if(!q.rowCount)fail(404,'Bank statement batch not found');
  return q.rows[0];
 };
 const report=async(db,b)=>{
  const [statement,books,aggregate,unmatched]=await Promise.all([
   db.query(
    "SELECT s.id,s.line_number,s.bank_transaction_id,s.value_date::text,s.amount_paisa::text,s.description,m.id AS match_id,m.voucher_line_id,v.voucher_number,v.voucher_date::text AS book_date FROM brs_statement_lines s LEFT JOIN brs_matches m ON m.company_id=s.company_id AND m.statement_line_id=s.id LEFT JOIN voucher_lines l ON l.company_id=m.company_id AND l.id=m.voucher_line_id LEFT JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id WHERE s.company_id=$1 AND s.batch_id=$2 ORDER BY s.line_number",
    [company,b.id]),
   db.query(
    "SELECT l.id AS voucher_line_id,v.voucher_number,v.voucher_date::text,v.narrative,(l.debit_paisa-l.credit_paisa)::text AS signed_paisa,m.id AS match_id FROM voucher_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id LEFT JOIN brs_matches m ON m.company_id=l.company_id AND m.voucher_line_id=l.id WHERE l.company_id=$1 AND l.account_id=$2 AND v.status='POSTED' AND v.voucher_date<=$3 ORDER BY v.voucher_date DESC,v.voucher_number DESC LIMIT 400",
    [company,b.account_id,b.ends_on]),
   db.query(
    "SELECT coalesce(sum(l.debit_paisa-l.credit_paisa),0)::text AS book_closing_paisa FROM voucher_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id WHERE l.company_id=$1 AND l.account_id=$2 AND v.status='POSTED' AND v.voucher_date<=$3",
    [company,b.account_id,b.ends_on]),
   db.query(
    "SELECT coalesce(sum(CASE WHEN (l.debit_paisa-l.credit_paisa)>0 THEN l.debit_paisa-l.credit_paisa ELSE 0 END),0)::text AS uncleared_deposits_paisa,coalesce(sum(CASE WHEN (l.debit_paisa-l.credit_paisa)<0 THEN l.credit_paisa-l.debit_paisa ELSE 0 END),0)::text AS uncleared_withdrawals_paisa,count(*)::int AS uncleared_book_count FROM voucher_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id LEFT JOIN brs_matches m ON m.company_id=l.company_id AND m.voucher_line_id=l.id WHERE l.company_id=$1 AND l.account_id=$2 AND v.status='POSTED' AND v.voucher_date<=$3 AND m.id IS NULL",
    [company,b.account_id,b.ends_on])
  ]);
  const lines=statement.rows;
  const notMatched=lines.filter(x=>!x.match_id).length;
  const deposits=asPaisa(unmatched.rows[0].uncleared_deposits_paisa);
  const checks=asPaisa(unmatched.rows[0].uncleared_withdrawals_paisa);
  const bankClosing=asPaisa(b.closing_paisa);
  const bookClosing=asPaisa(aggregate.rows[0].book_closing_paisa);
  const adjusted=bankClosing+deposits-checks;
  return {
   batch:b,statement_lines:lines,book_lines:books.rows,
   summary:{
    book_closing_paisa:bookClosing.toString(),
    bank_closing_paisa:bankClosing.toString(),
    uncleared_deposits_paisa:deposits.toString(),
    uncleared_withdrawals_paisa:checks.toString(),
    adjusted_bank_paisa:adjusted.toString(),
    difference_paisa:(bookClosing-adjusted).toString(),
    unmatched_bank_count:notMatched,
    uncleared_book_count:unmatched.rows[0].uncleared_book_count,
    reconciled:notMatched===0&&bookClosing===adjusted,
    note:'No GL posting occurs here. Unmatched bank entries require source documentation and ordinary finance posting; uploaded bank data is not independently verified.'
   }
  };
 };
 if(path==='/api/brs/batches'&&req.method==='GET'){
  canRead();
  const r=await pool.query(
   'SELECT b.id,b.statement_reference,b.starts_on::text,b.ends_on::text,b.opening_paisa::text,b.closing_paisa::text,b.status,b.imported_at,b.reviewed_at,a.code AS account_code FROM brs_batches b JOIN accounts a ON a.company_id=b.company_id AND a.id=b.account_id WHERE b.company_id=$1 ORDER BY b.ends_on DESC,b.imported_at DESC LIMIT 100',
   [company]);
  send(res,200,{batches:r.rows});return true;
 }
 if(path==='/api/brs/batches'&&req.method==='POST'){
  maker();
  const d=await parse(x=>{
   if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Bank statement payload required');
   const statementReference=stringField(x.statementReference,'Bank statement reference',120,4);
   const startsOn=validBankDate(x.startsOn,'Statement start');
   const endsOn=validBankDate(x.endsOn,'Statement end');
   if(startsOn>endsOn)throw Error('Statement end is before start');
   const opening=money(x.openingBalance,{zero:true}),closing=money(x.closingBalance,{zero:true});
   if(!Array.isArray(x.rows)||x.rows.length<1||x.rows.length>100)throw Error('Provide 1–100 bank statement rows');
   const ids=new Set();
   const rows=x.rows.map((r,i)=>{
    const bankId=stringField(r?.bankTransactionId,'Bank transaction ID',120,3);
    if(ids.has(bankId))throw Error('Duplicate transaction ID in this statement: '+bankId);
    ids.add(bankId);
    const valueDate=validBankDate(r.valueDate,'Bank value date');
    if(valueDate<startsOn||valueDate>endsOn)throw Error('Bank transaction outside imported statement dates');
    return {bankId,valueDate,
      amount:money(r.amount),description:stringField(r.description,'Bank narration',500,3),number:i+1};
   });
   const rowSum=rows.reduce((a,r)=>a+r.amount,0n);
   if(opening+rowSum!==closing)throw Error('Statement opening plus movement does not equal closing balance');
   return {statementReference,startsOn,endsOn,opening,closing,rows};
  });
  const result=await tx(pool,async db=>{
   const bank=await bankAccount(db);
   // Serialise imports for this bank account and prevent statement overlap.
   await db.query('SELECT id FROM accounts WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,bank.id]);
   const previous=await db.query(
    'SELECT status,ends_on::text,closing_paisa::text FROM brs_batches WHERE company_id=$1 AND account_id=$2 ORDER BY ends_on DESC LIMIT 1 FOR UPDATE',
    [company,bank.id]);
   if(previous.rowCount){
    const prev=previous.rows[0];
    if(prev.status!=='FINALIZED')fail(409,'Finalize the previous statement before importing the next one');
    if(d.startsOn!==dayAfter(prev.ends_on))fail(409,'Next statement must begin the day after the previous statement ends');
    if(d.opening!==asPaisa(prev.closing_paisa))fail(409,'Statement opening must equal previous closing balance');
   }
   const batch=await db.query(
    'INSERT INTO brs_batches(company_id,account_id,statement_reference,starts_on,ends_on,opening_paisa,closing_paisa,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [company,bank.id,d.statementReference,d.startsOn,d.endsOn,d.opening.toString(),d.closing.toString(),user]);
   for(const r of d.rows){
    await db.query(
     'INSERT INTO brs_statement_lines(company_id,batch_id,account_id,line_number,bank_transaction_id,value_date,amount_paisa,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
     [company,batch.rows[0].id,bank.id,r.number,r.bankId,r.valueDate,r.amount.toString(),r.description]);
   }
   await audit(db,'BANK_STATEMENT_IMPORTED',batch.rows[0].id,{
    accountCode:bank.code,reference:d.statementReference,lines:d.rows.length,
    start:d.startsOn,end:d.endsOn,closingPaisa:d.closing.toString()
   });
   return {id:batch.rows[0].id,statement_reference:d.statementReference,imported_lines:d.rows.length,status:'DRAFT'};
  });
  send(res,201,result);return true;
 }
 const detail=/^\/api\/brs\/batches\/([a-f0-9-]{36})$/i.exec(path);
 if(detail&&req.method==='GET'){
  canRead();
  const b=await getBatch(pool,requiredId(detail[1],'Statement batch'));
  send(res,200,await report(pool,b));return true;
 }
 const match=/^\/api\/brs\/batches\/([a-f0-9-]{36})\/match$/i.exec(path);
 if(match&&req.method==='POST'){
  maker();
  const d=await parse(x=>({statementLineId:requiredId(x?.statementLineId,'Bank statement line'),
    voucherLineId:requiredId(x?.voucherLineId,'Posted bank GL line')}));
  const result=await tx(pool,async db=>{
   const b=await getBatch(db,match[1],true);
   if(b.status!=='DRAFT')fail(409,'Statement is finalized');
   const s=await db.query('SELECT id,amount_paisa::text FROM brs_statement_lines WHERE company_id=$1 AND batch_id=$2 AND id=$3',
     [company,b.id,d.statementLineId]);
   if(!s.rowCount)fail(404,'Statement line not found');
   const l=await db.query(
    "SELECT l.id,(l.debit_paisa-l.credit_paisa)::text AS amount,v.voucher_date::text,v.status FROM voucher_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id WHERE l.company_id=$1 AND l.id=$2 AND l.account_id=$3",
    [company,d.voucherLineId,b.account_id]);
   if(!l.rowCount)fail(404,'Bank GL line not found');
   if(l.rows[0].status!=='POSTED'||l.rows[0].voucher_date>b.ends_on||
      l.rows[0].amount!==s.rows[0].amount_paisa)
     fail(409,'Only same-account posted GL transactions with exactly the same signed amount can match');
   const m=await db.query(
    'INSERT INTO brs_matches(company_id,batch_id,statement_line_id,voucher_line_id,matched_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [company,b.id,d.statementLineId,d.voucherLineId,user]);
   await audit(db,'BANK_ENTRY_MATCHED',m.rows[0].id,{
    batch:b.id,bankLineId:d.statementLineId,glLineId:d.voucherLineId,amountPaisa:s.rows[0].amount_paisa
   });
   return {id:m.rows[0].id,statement_line_id:d.statementLineId,voucher_line_id:d.voucherLineId};
  });
  send(res,201,result);return true;
 }
 const unmatch=/^\/api\/brs\/batches\/([a-f0-9-]{36})\/unmatch$/i.exec(path);
 if(unmatch&&req.method==='POST'){
  maker();
  const d=await parse(x=>({statementLineId:requiredId(x?.statementLineId,'Bank statement line')}));
  const result=await tx(pool,async db=>{
   const b=await getBatch(db,unmatch[1],true);
   if(b.status!=='DRAFT')fail(409,'Finalized bank matches cannot be undone');
   const m=await db.query(
    'DELETE FROM brs_matches WHERE company_id=$1 AND batch_id=$2 AND statement_line_id=$3 RETURNING id,voucher_line_id',
    [company,b.id,d.statementLineId]);
   if(!m.rowCount)fail(404,'This statement line is not matched');
   await audit(db,'BANK_ENTRY_UNMATCHED',m.rows[0].id,{batch:b.id,bankLineId:d.statementLineId,glLineId:m.rows[0].voucher_line_id});
   return {ok:true,unmatched_statement_line:d.statementLineId};
  });
  send(res,200,result);return true;
 }
 const finalize=/^\/api\/brs\/batches\/([a-f0-9-]{36})\/finalize$/i.exec(path);
 if(finalize&&req.method==='POST'){
  checker();
  const result=await tx(pool,async db=>{
   const b=await getBatch(db,finalize[1],true);
   if(b.status!=='DRAFT')fail(409,'Statement has already been finalized');
   if(b.imported_by===user)fail(403,'The same person may not import and approve the statement');
   const current=await report(db,b);
   if(!current.summary.reconciled)fail(409,'Cannot finalize: unmatched bank entries or non-zero bank vs book variance');
   const r=await db.query(
    "UPDATE brs_batches SET status='FINALIZED',reviewed_by=$1,reviewed_at=now() WHERE company_id=$2 AND id=$3 RETURNING id,status",
    [user,company,b.id]);
   await audit(db,'BANK_RECONCILIATION_FINALIZED',b.id,{
    reference:b.statement_reference,bookPaisa:current.summary.book_closing_paisa,
    bankPaisa:current.summary.bank_closing_paisa,
    unclearedDepositsPaisa:current.summary.uncleared_deposits_paisa,
    unclearedWithdrawalsPaisa:current.summary.uncleared_withdrawals_paisa
   });
   return {id:r.rows[0].id,status:r.rows[0].status,summary:current.summary};
  });
  send(res,200,result);return true;
 }
 return false;
}

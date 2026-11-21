import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Phase 11: two-stage posted-bank-ledger reconciliation preserves outstanding cheques and requires Admin review',{
 skip:!process.env.DATABASE_URL
},async t=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const tag=randomBytes(5).toString('hex');
 const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['R'+tag,'BRS QA Dealer'])).rows[0].id;
 const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',['S'+tag,'Other Dealer'])).rows[0].id;
 await pool.query('INSERT INTO departments(company_id,code,name) VALUES($1,$2)',[company,'FINANCE','Finance']);
 await pool.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,'2026-11']);
 for(const [code,name,kind] of [
  ['1020402001','Bank','ASSET'],
  ['3010101001','Capital','EQUITY'],
  ['5010101001','Office Expense','EXPENSE']
 ])await pool.query('INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',[company,code,name,kind]);
 const members={},password='Independent-Review-Test-Password-2026!';
 for(const role of ['FINANCE','ADMIN','PARTS']){
  const email=role.toLowerCase()+'-'+tag+'@example.test';
  const uid=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
   [email,hashPassword(password)])).rows[0].id;
  await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',
   [company,uid,role]);
  members[role]={email,uid};
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
 const post=(path,body,role='FINANCE')=>request(path,{method:'POST',body,role});
 for(const role of Object.keys(members)){
  const login=await request('/api/auth/login',{method:'POST',tenant:null,role,
   body:{email:members[role].email,password}});
  assert.equal(login.status,200,role+' login');members[role].cookie=login.cookie;
 }
 assert.equal((await request('/api/brs/batches',{tenant:other})).status,403,'Company B cannot see A statements');
 assert.equal((await get('/api/brs/batches','PARTS')).status,403,'Parts cannot see bank details');
 assert.equal((await post('/api/brs/batches',{statementReference:'BR-1'},'ADMIN')).status,403,
   'Admin may not import the statement');
 assert.equal((await get('/api/brs/batches')).data.batches.length,0);
 async function ledgerVoucher({debit,credit,amount,description,date='2026-11-20'}){
  const b=await post('/api/vouchers',{
   type:'JV',department:'FINANCE',date,narrative:description,
   lines:[{accountCode:debit,debit:amount,credit:'0'},
    {accountCode:credit,debit:'0',credit:amount}]
  });
  assert.equal(b.status,201,JSON.stringify(b.data));
  const r=await post('/api/vouchers/'+b.data.id+'/post',{});
  assert.equal(r.status,200,JSON.stringify(r.data));
  return b.data.id;
 }
 const cashIn=await ledgerVoucher({debit:'1020402001',credit:'3010101001',amount:'1000.00',description:'Example bank deposit'});
 const cheque=await ledgerVoucher({debit:'5010101001',credit:'1020402001',amount:'200.00',description:'Outstanding supplier cheque'});
 const bankId=(await pool.query("SELECT id FROM accounts WHERE company_id=$1 AND code='1020402001'",[company])).rows[0].id;
 const bankLines=await pool.query(
  'SELECT l.id,l.voucher_id,(l.debit_paisa-l.credit_paisa)::text AS amount FROM voucher_lines l WHERE l.company_id=$1 AND l.account_id=$2',
  [company,bankId]);
 const creditLine=bankLines.rows.find(x=>x.voucher_id===cashIn),debitLine=bankLines.rows.find(x=>x.voucher_id===cheque);
 assert.equal(creditLine.amount,'100000');assert.equal(debitLine.amount,'-20000');
 const firstBody={statementReference:'STMT-1-'+tag,startsOn:'2026-11-20',endsOn:'2026-11-20',
  openingBalance:'0.00',closingBalance:'1000.00',
  rows:[{bankTransactionId:'BANK-DEP-'+tag,valueDate:'2026-11-20',
   amount:'1000.00',description:'Confirmed customer deposit'}]};
 assert.equal((await post('/api/brs/batches',{...firstBody,closingBalance:'950.00'})).status,400,
   'Statement balance must reconcile to its own imported movements');
 assert.equal((await post('/api/brs/batches',{...firstBody,rows:[]})).status,400,
   'Empty statement cannot be imported');
 const imported=await post('/api/brs/batches',firstBody);
 assert.equal(imported.status,201,JSON.stringify(imported.data));
 const id=imported.data.id;
 assert.equal((await post('/api/brs/batches',firstBody)).status,409,'Duplicate statement rejected');
 assert.equal((await post('/api/brs/batches',{
  ...firstBody,statementReference:'STMT-EARLY-'+tag,startsOn:'2026-11-21',endsOn:'2026-11-21',
  openingBalance:'1000.00',closingBalance:'1000.00'
 })).status,400,'No zero-row bank statement import');

 let detail=await get('/api/brs/batches/'+id);
 assert.equal(detail.status,200);
 assert.equal(detail.data.summary.book_closing_paisa,'80000');
 assert.equal(detail.data.summary.bank_closing_paisa,'100000');
 assert.equal(detail.data.summary.uncleared_deposits_paisa,'100000');
 assert.equal(detail.data.summary.uncleared_withdrawals_paisa,'20000');
 assert.equal(detail.data.summary.difference_paisa,'-100000');
 assert.equal(detail.data.summary.unmatched_bank_count,1);
 const bankTransaction=detail.data.statement_lines[0].id;
 assert.equal((await post('/api/brs/batches/'+id+'/finalize',{},'FINANCE')).status,403);
 assert.equal((await post('/api/brs/batches/'+id+'/finalize',{},'ADMIN')).status,409,
   'Cannot approve reconciliation while bank transaction is unmatched');
 assert.equal((await post('/api/brs/batches/'+id+'/match',
   {statementLineId:bankTransaction,voucherLineId:debitLine.id})).status,409,
   'Direction/amount mismatch must fail');
 assert.equal((await post('/api/brs/batches/'+id+'/match',
   {statementLineId:bankTransaction,voucherLineId:creditLine.id},'ADMIN')).status,403,
   'Admin must not perform Finance matching');
 const matched=await post('/api/brs/batches/'+id+'/match',
  {statementLineId:bankTransaction,voucherLineId:creditLine.id});
 assert.equal(matched.status,201,JSON.stringify(matched.data));
 assert.equal((await post('/api/brs/batches/'+id+'/match',
   {statementLineId:bankTransaction,voucherLineId:creditLine.id})).status,409,
   'Cannot double-match a statement line');
 const matchedDetail=await get('/api/brs/batches/'+id);
 assert.equal(matchedDetail.data.summary.uncleared_deposits_paisa,'0');
 assert.equal(matchedDetail.data.summary.uncleared_withdrawals_paisa,'20000');
 assert.equal(matchedDetail.data.summary.adjusted_bank_paisa,'80000');
 assert.equal(matchedDetail.data.summary.difference_paisa,'0');
 assert.equal(matchedDetail.data.summary.reconciled,true,
   'Outstanding cheque stays open while first statement reconciles');
 assert.equal((await post('/api/brs/batches/'+id+'/unmatch',
  {statementLineId:bankTransaction})).status,200);
 const rematched=await post('/api/brs/batches/'+id+'/match',
  {statementLineId:bankTransaction,voucherLineId:creditLine.id});
 assert.equal(rematched.status,201);
 const approved=await post('/api/brs/batches/'+id+'/finalize',{},'ADMIN');
 assert.equal(approved.status,200,JSON.stringify(approved.data));
 assert.equal(approved.data.status,'FINALIZED');
 assert.equal(approved.data.summary.reconciled,true);
 assert.equal((await post('/api/brs/batches/'+id+'/finalize',{},'ADMIN')).status,409);
 assert.equal((await post('/api/brs/batches/'+id+'/unmatch',{statementLineId:bankTransaction})).status,409);
 await assert.rejects(pool.query('DELETE FROM brs_statement_lines WHERE id=$1',[bankTransaction]),/immutable/);

 // A posted Bank movement within a finalized statement cutoff is disallowed.
 const backdated=await post('/api/vouchers',{type:'JV',department:'FINANCE',date:'2026-11-20',
  narrative:'Attempt to alter closed BRS',
  lines:[{accountCode:'1020402001',debit:'5.00',credit:'0'},
   {accountCode:'3010101001',debit:'0',credit:'5.00'}]});
 assert.equal(backdated.status,201);
 assert.equal((await post('/api/vouchers/'+backdated.data.id+'/post',{})).status,409,
   'No new backdated Bank GL postings after BRS finalization');
 assert.equal((await post('/api/vouchers/'+cashIn+'/reverse',{
   date:'2026-11-21',reason:'Cannot reverse a BRS matched receipt'
 })).status,409,'Matched voucher must not be generically reversed');
 const secondBody={statementReference:'STMT-2-'+tag,startsOn:'2026-11-21',endsOn:'2026-11-21',
  openingBalance:'1000.00',closingBalance:'800.00',
  rows:[{bankTransactionId:'BANK-CHQ-'+tag,valueDate:'2026-11-21',
   amount:'-200.00',description:'Outstanding cheque cleared'}]};
 assert.equal((await post('/api/brs/batches',{...secondBody,openingBalance:'500.00'})).status,400,
   'Opening-plus-movement arithmetic must be valid');
 assert.equal((await post('/api/brs/batches',{...secondBody,startsOn:'2026-11-22',endsOn:'2026-11-22',
   rows:[{...secondBody.rows[0],valueDate:'2026-11-22'}]})).status,409,
   'No bank statement date gap may go unnoticed');
 const second=await post('/api/brs/batches',secondBody);
 assert.equal(second.status,201,JSON.stringify(second.data));
 const secondId=second.data.id;
 const open=await get('/api/brs/batches/'+secondId);
 const secondStatementLine=open.data.statement_lines[0].id;
 assert.equal(open.data.summary.uncleared_withdrawals_paisa,'20000');
 const followup=await post('/api/brs/batches/'+secondId+'/match',{
   statementLineId:secondStatementLine,voucherLineId:debitLine.id
 });
 assert.equal(followup.status,201,JSON.stringify(followup.data));
 const final=await post('/api/brs/batches/'+secondId+'/finalize',{},'ADMIN');
 assert.equal(final.status,200,JSON.stringify(final.data));
 assert.equal(final.data.summary.adjusted_bank_paisa,'80000');
 assert.equal(final.data.summary.book_closing_paisa,'80000');
 assert.equal(final.data.summary.uncleared_book_count,0);
 const trial=await get('/api/reports/trial-balance');
 assert.equal(trial.data.rows.find(x=>x.code==='1020402001').balance_paisa,'80000',
   'Matching and approval must never alter GL');
 const events=await pool.query("SELECT action FROM audit_events WHERE company_id=$1 AND action LIKE 'BANK_%'",[company]);
 const kinds=events.rows.map(r=>r.action);
 assert.equal(kinds.filter(x=>x==='BANK_STATEMENT_IMPORTED').length,2);
 assert.equal(kinds.filter(x=>x==='BANK_ENTRY_MATCHED').length,3);
 assert.equal(kinds.filter(x=>x==='BANK_ENTRY_UNMATCHED').length,1);
 assert.equal(kinds.filter(x=>x==='BANK_RECONCILIATION_FINALIZED').length,2);
});

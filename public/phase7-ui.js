/* AQVORA Plus Phase 7 — maker-checker supplier returns / bank refund receipts. */
(function(){
'use strict';
const state={};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>{const n=BigInt(v||0),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n).toLocaleString('en-PK')+'.'+String(a%100n).padStart(2,'0');};
const td=x=>'<td>'+esc(x)+'</td>';
const amt=x=>'<td class="amount">PKR '+money(x)+'</td>';
const table=(h,rows)=>'<div class="table-wrap"><table><thead><tr>'+h.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+
 (rows.length?rows.join(''):'<tr><td class="empty" colspan="'+h.length+'">No records</td></tr>')+'</tbody></table></div>';
const card=(title,content)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(title)+'</h2></div>'+content+'</div>';
const input=(label,name,type='text',value='',required=true)=>'<div class="field"><label>'+esc(label)+'</label><input name="'+esc(name)+'" type="'+type+'" value="'+esc(value)+'" '+(required?'required':'')+' /></div>';
const select=(label,name,values)=>'<div class="field"><label>'+esc(label)+'</label><select name="'+esc(name)+'" required><option value="">Choose a fully paid parts bill</option>'+
 values.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.reference+' / '+x.supplier_name+' / '+x.quantity+' units')+'</option>').join('')+'</select></div>';
const form=(mode,label,fields,footer)=>'<form id="phase7-form" data-mode="'+esc(mode)+'" class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(label)+'</h2></div><div class="card-body"><div class="form-grid">'+fields.join('')+'</div></div>'+
 '<div class="form-footer"><span class="muted small">'+esc(footer)+'</span><button type="submit" class="primary">Submit</button></div></form>';
const action=(label,verb,id)=>'<button type="button" class="secondary" data-action="phase7:'+esc(verb)+'" data-id="'+esc(id)+'">'+esc(label)+'</button>';
const localDate=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
async function load(page,api){
 const routes=[
  ['policy','/api/phase7/refund-policy'],
  ['refunds','/api/phase7/supplier-refunds'],
  ['audit','/api/phase7/supplier-refunds/audit']
 ];
 if(page==='phase7:queue')routes.push(['bills','/api/finance4/purchases']);
 const values=await Promise.all(routes.map(x=>api(x[1])));
 routes.forEach((x,i)=>state[x[0]]=values[i]);
 state.page=page;
}
function register(role){
 const policy=state.policy?.policy;
 const records=state.refunds?.requests||[];
 const audit=state.audit||{};
 const total=policy?.max_single_refund_paisa?money(policy.max_single_refund_paisa):null;
 const header='<div class="banner"><strong>Approved supplier bank receipts</strong>Finance requests a refund on a fully paid parts bill, Admin independently approves, and Finance posts only after confirming the supplier bank credit. The system does not verify actual bank transactions.</div>';
 const policyForm=role==='ADMIN'?form('policy','Configure Company Supplier Refund Limit',[
   input('Maximum per approved refund (PKR)','maxAmount','text',total||'10000.00')
 ],'Refunds will be blocked until Admin configures a limit.'):'';
 const allBills=state.bills?.purchases||[];
 const bills=allBills.filter(x=>x.bill_type==='PARTS'&&
   BigInt(x.paid_paisa)===BigInt(x.amount_paisa)&&
   BigInt(x.credited_paisa||0)===0n&&BigInt(x.refunded_paisa||0)===0n&&x.returned_qty===0);
 const submitForm=role==='FINANCE'?form('request','Request Paid Supplier Parts Refund',[
   select('Fully paid parts bill','billId',bills),
   input('Quantity to return','quantity','number','1'),
   input('Requested return date','returnDate','date',localDate()),
   input('Reason (min 8 characters)','reason')
 ],'This is a parts return, not a reversal of the original supplier payment.'):'';
 const items=records.map(x=>{
   const actionHtml=role==='ADMIN'&&x.status==='PENDING'?
    action('Approve','approve',x.id)+' '+action('Reject','reject',x.id):
    role==='FINANCE'&&x.status==='APPROVED'?action('Record Bank Refund','execute',x.id):'—';
   return '<tr>'+td(x.bill_reference)+td(x.supplier_name)+td(x.quantity)+amt(x.supplier_credit_paisa)+
    td(x.status)+td(x.requester_email)+td(x.reviewer_email||'—')+td(x.bank_reference||'—')+'<td>'+actionHtml+'</td></tr>';
 });
 const metrics='<div class="stat-grid">'+[
  ['Pending',audit.pending||0],['Approved',audit.approved||0],
  ['Executed',audit.executed||0],['Bank Receipts','PKR '+money(audit.received_paisa)]
 ].map(([label,value])=>'<div class="card stat"><span class="stat-kicker">'+esc(label)+'</span><strong class="stat-value">'+esc(value)+'</strong></div>').join('')+'</div>';
 return header+metrics+card('Company Refund Limit','<div class="card-body"><h2>'+ (total?'PKR '+esc(total):'Not configured')+
   '</h2><span class="muted small">All refunds require an independent Admin approval regardless of amount.</span></div>')+
   policyForm+submitForm+card('Supplier Refund Approval Queue',table(
    ['Bill','Supplier','Qty','Refund','Status','Requested By','Reviewed By','Bank Reference','Action'],items));
}
function audit(){
 const a=state.audit||{},records=state.refunds?.requests||[];
 return '<div class="banner"><strong>Supplier Refund Audit</strong>Includes approval and source-voucher reconciliation only. Confirm each bank reference independently against a real bank statement.</div>'+
  card('Refund Audit Controls',table(['Control','Value'],[
    '<tr>'+td('Executed / Approved / Pending')+td((a.executed||0)+' / '+(a.approved||0)+' / '+(a.pending||0))+'</tr>',
    '<tr>'+td('Recorded supplier bank refunds')+amt(a.received_paisa)+'</tr>',
    '<tr>'+td('Unposted bank refund vouchers')+td(a.unposted_bank_vouchers||0)+'</tr>',
    '<tr>'+td('Broken source links')+td(a.broken_links||0)+'</tr>',
    '<tr>'+td('Source reconciliation')+td(a.reconciled?'MATCH':'REQUIRES REVIEW')+'</tr>'
  ]))+card('Recent Refund Decisions',table(['Bill','Supplier','Qty','Amount','Status','Bank Reference'],
    records.map(x=>'<tr>'+td(x.bill_reference)+td(x.supplier_name)+td(x.quantity)+amt(x.supplier_credit_paisa)+td(x.status)+td(x.bank_reference||'—')+'</tr>')));
}
function render(page,role){return page==='phase7:audit'?audit():register(role);}
async function submit(event,{post,open,notify}){
 event.preventDefault();
 const f=event.target,mode=f.dataset.mode,values=Object.fromEntries(new FormData(f).entries());
 const url=mode==='policy'?'/api/phase7/refund-policy':'/api/phase7/supplier-refunds/requests';
 if(mode==='request'){values.clientKey=crypto.randomUUID();values.quantity=Number(values.quantity);}
 const b=f.querySelector('button[type=submit]');b.disabled=true;
 try{
  const result=await post(url,mode==='policy'?{maxAmount:values.maxAmount}:values);
  await open(state.page);notify(mode==='policy'?'Company approval limit saved':'Refund request submitted: '+result.id);
 }catch(e){notify(e.message,true);}finally{b.disabled=false;}
}
async function act(verb,id,{post,open,notify}){
 try{
  if(verb==='approve'||verb==='reject'){
    const decision=verb==='approve'?'APPROVED':'REJECTED';
    if(!confirm(decision+' supplier refund request? This decision is audited and irreversible.'))return;
    await post('/api/phase7/supplier-refunds/'+id+'/decision',{decision});
  }else if(verb==='execute'){
    const receivedDate=prompt('Verified supplier bank credit date (YYYY-MM-DD)',localDate());
    if(receivedDate===null)return;
    const bankReference=prompt('Bank receipt reference from independently verified bank statement');
    if(bankReference===null)return;
    if(!confirm('I have VERIFIED this supplier refund in the bank statement. Post return and receipt to General Ledger?'))return;
    await post('/api/phase7/supplier-refunds/'+id+'/execute',{receivedDate,bankReference});
  }else return;
  await open(state.page);notify('Supplier refund workflow updated');
 }catch(e){notify(e.message,true);}
}
window.AQVORA_PHASE7={load,render,submit,act};
})();
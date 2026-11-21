/* AQVORA Plus: bank statement reconciliation, development-only. */
(function(){
'use strict';
const state={batches:[],selectedId:null,detail:null};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=x=>{const n=BigInt(x||0),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n).toLocaleString('en-PK')+'.'+String(a%100n).padStart(2,'0');};
const td=x=>'<td>'+esc(x)+'</td>';
const table=(h,rs)=>'<div class="table-wrap"><table><thead><tr>'+h.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+
 (rs.length?rs.join(''):'<tr><td class="empty" colspan="'+h.length+'">No records</td></tr>')+'</tbody></table></div>';
const card=(title,html)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(title)+'</h2></div>'+html+'</div>';
const field=(name,label,type='text',value='')=>'<div class="field"><label>'+esc(label)+
 '<input type="'+type+'" name="'+esc(name)+'" value="'+esc(value)+'" required></label></div>';
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
async function load(page,api){
 const list=await api('/api/brs/batches');state.batches=list.batches||[];
 if(!state.selectedId&&state.batches.length)state.selectedId=state.batches[0].id;
 if(state.selectedId&&!state.batches.some(x=>x.id===state.selectedId))state.selectedId=state.batches[0]?.id||null;
 state.detail=state.selectedId?await api('/api/brs/batches/'+state.selectedId):null;
}
function parseCsv(input){
 const data=[],row=[];let value='',inside=false;
 const text=String(input||'').replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(ch==='"'){if(inside&&text[i+1]==='"'){value+='"';i++;}else inside=!inside;}
  else if(ch===','&&!inside){row.push(value);value='';}
  else if((ch==='\r'||ch==='\n')&&!inside){
   if(ch==='\r'&&text[i+1]==='\n')i++;
   row.push(value);value='';
   if(row.some(v=>v.trim()!==''))data.push(row.splice(0));else row.length=0;
  }else value+=ch;
 }
 if(inside)throw Error('CSV has an unclosed quoted value');
 row.push(value);if(row.some(v=>v.trim()!==''))data.push(row);
 if(data.length<2)throw Error('CSV requires a header and at least one transaction');
 const header=data.shift().map(v=>v.trim().toLowerCase());
 if(header.join(',')!=='transaction_id,date,amount,description')
  throw Error('Columns must be transaction_id,date,amount,description');
 if(data.length>100)throw Error('Import at most 100 transactions per statement');
 return data.map((r,i)=>{
  if(r.length!==4)throw Error('CSV row '+(i+2)+' must have four columns');
  return {bankTransactionId:r[0].trim(),valueDate:r[1].trim(),amount:r[2].trim(),description:r[3].trim()};
 });
}
function render(page,role){
 let html='<div class="banner"><strong>Bank Reconciliation</strong>Finance imports a statement and matches posted Bank GL lines; a separate Admin finalizes it. Statement data is manually supplied and not verified by a bank. Matching never posts a journal.</div>';
 if(role==='FINANCE'){
  html+='<form id="brs-import-form" class="card" style="margin-bottom:18px">'+
   '<div class="card-head"><h2>Import Statement CSV</h2></div>'+
   '<div class="card-body"><div class="form-grid">'+
    field('statementReference','Bank statement reference')+field('startsOn','From','date',today())+
    field('endsOn','To','date',today())+field('openingBalance','Opening balance (PKR)','text','0.00')+
    field('closingBalance','Closing balance (PKR)','text','0.00')+'</div>'+
    '<div class="field"><label>CSV file (optional)<input type="file" name="statementFile" accept=".csv,text/csv"></label></div>'+
    '<div class="field"><label>Or paste statement CSV</label><textarea rows="6" name="csvText" '+
    'placeholder="transaction_id,date,amount,description&#10;BANK-001,2026-11-20,1000.00,Customer deposit"></textarea></div>'+
    '<p class="muted small">Bank credit/inflow = positive; bank debit/outflow = negative. Required columns: transaction_id,date,amount,description. Max 100 lines. Opening plus line sum must equal closing. Next period must start the day after the previous finalized statement.</p>'+
    '</div><div class="form-footer"><span class="muted small">Use synthetic development data only.</span>'+
    '<button type="submit" class="primary">Import Statement</button></div></form>';
 }
 html+=card('Imported Statements',table(['Statement','Period','Opening','Closing','Status','Action'],
   state.batches.map(b=>'<tr>'+td(b.statement_reference)+td(b.starts_on+' → '+b.ends_on)+
   td('PKR '+money(b.opening_paisa))+td('PKR '+money(b.closing_paisa))+td(b.status)+
   '<td><button type="button" class="secondary" data-action="brs:view" data-id="'+esc(b.id)+'">Open</button></td></tr>')));
 const r=state.detail;if(!r)return html;
 const b=r.batch,s=r.summary;
 const metrics=[['Bank Closing',s.bank_closing_paisa],['Book Closing',s.book_closing_paisa],
  ['Uncleared Deposits',s.uncleared_deposits_paisa],['Outstanding Payments',s.uncleared_withdrawals_paisa],
  ['Adjusted Bank',s.adjusted_bank_paisa],['Difference',s.difference_paisa]];
 html+=card('BRS Control — '+b.statement_reference,
  '<div class="stat-grid">'+metrics.map(([name,v])=>
   '<div class="card stat"><span class="stat-kicker">'+esc(name)+'</span><strong class="stat-value">PKR '+money(v)+'</strong></div>'
  ).join('')+'</div><div class="card-body">'+
  '<p>'+esc('Statement: '+b.status+' | Unmatched bank: '+s.unmatched_bank_count+' | Uncleared book entries: '+s.uncleared_book_count)+'</p>'+
  '<p class="muted small">Outstanding deposits increase adjusted bank; uncleared payments decrease it. Bank-only transactions require investigation and authorized finance posting before final approval.</p>'+
  (role==='ADMIN'&&b.status==='DRAFT'?'<button type="button" class="primary" data-action="brs:finalize" data-id="'+esc(b.id)+'" '+(s.reconciled?'':'disabled')+'>Approve & Finalize BRS</button>':'')+
  '</div>');
 const available=r.book_lines.filter(l=>!l.match_id);
 const bankRows=r.statement_lines.map(x=>{
  let action=x.match_id?'Matched to '+(x.voucher_number||'voucher'):'Unmatched';
  if(role==='FINANCE'&&b.status==='DRAFT'){
   if(x.match_id)action='<button type="button" class="secondary" data-action="brs:unmatch" data-id="'+esc(x.id)+'">Unmatch</button>';
   else{
    const candidates=available.filter(l=>l.signed_paisa===x.amount_paisa);
    const options='<option value="">Select a posted GL entry</option>'+candidates.map(l=>
     '<option value="'+esc(l.voucher_line_id)+'">'+esc(l.voucher_number+' / '+l.voucher_date+' / PKR '+money(l.signed_paisa))+'</option>').join('');
    action='<select id="brs-select-'+esc(x.id)+'">'+options+'</select> '+
     '<button type="button" class="secondary" data-action="brs:match" data-id="'+esc(x.id)+'" '+(candidates.length?'':'disabled')+'>Match</button>';
   }
  }
  return '<tr>'+td(x.bank_transaction_id)+td(x.value_date)+td(x.description)+td('PKR '+money(x.amount_paisa))+
   td(x.match_id?'Matched':'Unmatched')+'<td>'+action+'</td></tr>';
 });
 html+=card('Statement Movements',table(['Bank Txn ID','Date','Description','Signed Amount','Status','Match'],bankRows));
 html+=card('Bank GL Movements (latest 400)',table(['Voucher','Date','Narration','Signed Amount','Status'],
  r.book_lines.map(x=>'<tr>'+td(x.voucher_number)+td(x.voucher_date)+td(x.narrative)+
   td('PKR '+money(x.signed_paisa))+td(x.match_id?'Matched':'Outstanding')+'</tr>')));
 return html;
}
async function submit(event,{post,open,notify}){
 event.preventDefault();
 const f=event.target,button=f.querySelector('button[type=submit]');button.disabled=true;
 try{
  const data=new FormData(f),file=data.get('statementFile');
  const csv=file&&file.size>0?await file.text():String(data.get('csvText')||'');
  const rows=parseCsv(csv);
  const payload={statementReference:data.get('statementReference'),startsOn:data.get('startsOn'),endsOn:data.get('endsOn'),
   openingBalance:data.get('openingBalance'),closingBalance:data.get('closingBalance'),rows};
  const res=await post('/api/brs/batches',payload);
  state.selectedId=res.id;await open('brs:workspace');
  notify('Imported '+res.imported_lines+' bank movements for Finance matching');
 }catch(err){notify(err.message,true);}finally{button.disabled=false;}
}
async function act(action,id,{post,open,notify}){
 try{
  if(action==='view'){state.selectedId=id;await open('brs:workspace');return;}
  if(!state.selectedId)throw Error('Open a bank statement first');
  if(action==='match'){
   const selected=document.getElementById('brs-select-'+id)?.value;
   if(!selected)throw Error('Choose a GL movement with matching amount and direction');
   await post('/api/brs/batches/'+state.selectedId+'/match',{statementLineId:id,voucherLineId:selected});
  }else if(action==='unmatch'){
   if(!confirm('Unmatch this transaction? The change will be audited.'))return;
   await post('/api/brs/batches/'+state.selectedId+'/unmatch',{statementLineId:id});
  }else if(action==='finalize'){
   if(!confirm('Finalize BRS? Matching will lock and backdated Bank GL postings will be rejected.'))return;
   await post('/api/brs/batches/'+state.selectedId+'/finalize',{});
  }else return;
  await open('brs:workspace');notify('Bank reconciliation updated');
 }catch(err){notify(err.message,true);}
}
window.AQVORA_BRS={load,render,submit,act};
})();
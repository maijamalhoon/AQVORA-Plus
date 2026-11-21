/* AQVORA Plus — original web UI. Server owns all financial writes and authorization. */
'use strict';
const $=id=>document.getElementById(id);
const state={user:null,memberships:[],selected:null,accounts:[],departments:[],vouchers:[],report:[],ledger:[],audit:[],detail:null,page:'dashboard',busy:false};
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
const esc=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const money=v=>{const n=BigInt(v||0),abs=n<0n?-n:n;return (n<0n?'-':'')+(abs/100n).toLocaleString('en-PK')+'.'+String(abs%100n).padStart(2,'0');};
const moneyClass=v=>BigInt(v||0)<0n?'negative':'';
const parsePaisa=raw=>{const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(raw).trim().replaceAll(',',''));return m?BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0')||'0'):null;};
const table=(heads,rows,empty='No records available')=>'<div class="table-wrap"><table><thead><tr>'+heads.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+ (rows.length?rows.join(''):'<tr><td colspan="'+heads.length+'" class="empty">'+esc(empty)+'</td></tr>')+'</tbody></table></div>';
const button=(label,action,additional='',kind='secondary')=>'<button type="button" class="'+kind+'" data-action="'+esc(action)+'" '+additional+'>'+esc(label)+'</button>';
const api=async(path,opts={})=>{
  const headers={'Accept':'application/json',...(opts.body?{'Content-Type':'application/json','X-AQVORA-Request':'1'}:{}),...(opts.method==='POST'&&!opts.body?{'X-AQVORA-Request':'1'}:{}),...(state.selected?{'X-Company-ID':state.selected.company_id}:{})};
  const response=await fetch(path,{credentials:'same-origin',...opts,headers:{...headers,...opts.headers}});
  const payload=await response.json().catch(()=>({error:'Invalid server response'}));
  if(!response.ok)throw Error(payload.error||('Request failed: '+response.status));
  return payload;
};
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
const notify=(msg,error=false)=>{const box=$('flash');box.className='flash'+(error?' error':'');box.textContent=msg;box.classList.remove('hidden');};
const clearNotice=()=>$('flash').classList.add('hidden');
const finance=()=>['ADMIN','FINANCE','VIEWER'].includes(state.selected?.role);
const editor=()=>['ADMIN','FINANCE'].includes(state.selected?.role);
const documents=[['JV','Journal Voucher'],['CB/R','Cash Book Receipt'],['CB/P','Cash Book Payment'],['BB/R','Bank Book Receipt'],['BB/P','Bank Book Payment']];
const operations={SALES:['Order Form','Sales Note','Vehicle Delivery','Sales Reports'],SERVICE:['Appointment','Estimate','Day End'],PARTS:['Requisition','Purchase Order','GRN','Purchase Return','Stock Valuation']};
function navigation(){
  const items=[{id:'dashboard',text:'Dashboard',group:'Overview'}];
  if(finance()){
    items.push({id:'vouchers',text:'Voucher Register',group:'Financials / Accounts'});
    if(editor())documents.forEach(([type,text])=>items.push({id:'new:'+type,text,group:'Financials / Accounts'}));
    items.push({id:'trial',text:'Trial Balance',group:'Financial Reports'},{id:'ledger',text:'General Ledger',group:'Financial Reports'},{id:'audit',text:'Audit Trail',group:'Financial Reports'});
  }
  const modules=[
    {id:'auto:customers',text:'Customers',group:'CRM',roles:['ADMIN','SALES','SERVICE','FINANCE']},
    {id:'auto:vehicle-stock',text:'Vehicle Stock',group:'Sales Operations',roles:['ADMIN','SALES','FINANCE']},
    {id:'auto:sales-bookings',text:'Sales Bookings',group:'Sales Operations',roles:['ADMIN','SALES','FINANCE']},
    {id:'auto:customer-vehicles',text:'Customer Vehicles',group:'Service Operations',roles:['ADMIN','SERVICE','FINANCE']},
    {id:'auto:service-jobs',text:'Job Cards',group:'Service Operations',roles:['ADMIN','SERVICE','PARTS','FINANCE']},
    {id:'auto:service-invoices',text:'Service Invoices',group:'Service Operations',roles:['ADMIN','SERVICE','FINANCE']},
    {id:'auto:parts',text:'Parts Master',group:'Parts Operations',roles:['ADMIN','PARTS','SERVICE','FINANCE']},
    {id:'auto:stock-movements',text:'Stock Movements',group:'Parts Operations',roles:['ADMIN','PARTS','SERVICE','FINANCE']},
    {id:'auto:ar-aging',text:'AR Aging',group:'Financial Reports',roles:['ADMIN','FINANCE']}
  ];
  const controls=[
    {id:'fin4:suppliers',text:'Suppliers',group:'Master Data / Finance',roles:['ADMIN','FINANCE']},
    {id:'fin4:purchases',text:'Purchase Bills / Payables',group:'Financials / Procurement',roles:['ADMIN','FINANCE']},
    {id:'fin4:sales',text:'Vehicle Sales Invoices',group:'Sales Operations',roles:['ADMIN','FINANCE','SALES']},
    {id:'fin4:parts',text:'Parts Valuation & COGS',group:'Parts Operations',roles:['ADMIN','FINANCE','PARTS']},
    {id:'fin4:reconciliation',text:'Control Reconciliation',group:'Financial Reports',roles:['ADMIN','FINANCE']}
  ];
  const phase5=[
    {id:'phase5:tax',text:'Tax Codes',group:'Finance Setup',roles:['ADMIN','FINANCE']},
    {id:'phase5:returns',text:'Purchase Returns',group:'Financials / Procurement',roles:['ADMIN','FINANCE']},
    {id:'phase5:credits',text:'Vehicle Credit Notes',group:'Financials / Accounts',roles:['ADMIN','FINANCE']},
    {id:'phase5:deliveries',text:'Vehicle Delivery Notes',group:'Sales Operations',roles:['ADMIN','FINANCE','SALES']},
    {id:'phase5:ap',text:'AP Aging',group:'Financial Reports',roles:['ADMIN','FINANCE']},
    {id:'phase5:tax-report',text:'Tax Summary',group:'Financial Reports',roles:['ADMIN','FINANCE']},
    {id:'phase5:margin',text:'Sales Margin',group:'Financial Reports',roles:['ADMIN','FINANCE','SALES']}
  ];
  const phase6=[
    {id:'phase6:queue',text:'Refund Approvals',group:'Financials / Accounts',roles:['ADMIN','FINANCE']},
    {id:'phase6:audit',text:'Refund Audit',group:'Financial Reports',roles:['ADMIN','FINANCE']}
  ];
  const phase7=[
    {id:'phase7:queue',text:'Supplier Refunds',group:'Financials / Procurement',roles:['ADMIN','FINANCE']},
    {id:'phase7:audit',text:'Supplier Refund Audit',group:'Financial Reports',roles:['ADMIN','FINANCE']}
  ];
  modules.concat(controls,phase5,phase6,phase7).filter(x=>x.roles.includes(state.selected.role)).forEach(x=>items.push(x));
  Object.entries(operations).forEach(([dep,labels])=>{
    if(state.selected.role==='ADMIN'||state.selected.role===dep)
      labels.forEach(text=>items.push({id:'planned:'+dep+':'+text,text,group:dep+' Operations',planned:true}));
  });
  return items;
}
function renderNav(){
  let last='';$('nav').innerHTML=navigation().map(item=>{
    const group=item.group===last?'':'<div class="group-title">'+esc(item.group)+'</div>';last=item.group;
    return group+'<button type="button" data-page="'+esc(item.id)+'" class="'+(state.page===item.id?'active':'')+'"><span>'+esc(item.text)+'</span>'+(item.planned?'<small>SOON</small>':'')+'</button>';
  }).join('');
}
function showLogin(){
  $('shell').classList.add('hidden');$('login').classList.remove('hidden');
  state.user=null;state.selected=null;
}
function showShell(){
  $('login').classList.add('hidden');$('shell').classList.remove('hidden');
  $('role-chip').textContent=state.selected.role;
  $('company-select').innerHTML=state.memberships.map(m=>'<option value="'+esc(m.company_id)+'" '+(m.company_id===state.selected.company_id?'selected':'')+'>'+esc(m.company_name)+'</option>').join('');
  $('today').textContent=today();
  render();
}
async function refresh(){
  const me=await api('/api/auth/me');state.user=me.user;state.memberships=me.memberships;state.selected=me.selected;
  if(finance()){
    const data=await Promise.all([api('/api/accounts'),api('/api/departments'),api('/api/vouchers'),api('/api/reports/trial-balance')]);
    state.accounts=data[0].accounts;state.departments=data[1].departments;state.vouchers=data[2].vouchers;state.report=data[3].rows;
  } else {state.accounts=[];state.departments=[];state.vouchers=[];state.report=[];}
  showShell();
}
function stat(label,value,info){return '<div class="card stat accent-border"><span class="stat-kicker">'+esc(label)+'</span><strong class="stat-value">'+esc(value)+'</strong><p>'+esc(info)+'</p></div>';}
function balance(code){return state.report.find(r=>r.code===code)?.balance_paisa||'0';}
function dashboard(){
  const posted=state.vouchers.filter(v=>v.status==='POSTED').length;
  const pending=state.vouchers.filter(v=>v.status==='DRAFT').length;
  const stats=finance()
   ?stat('POSTED VOUCHERS',posted,'Posted documents in recent register')
    +stat('DRAFT VOUCHERS',pending,'Pending review and posting')
    +stat('BANK BALANCE','PKR '+money(balance('1020402001')),'Net posted demo-account activity')
    +stat('ACCOUNTS RECEIVABLE','PKR '+money(balance('1020301001')),'Net receivable balance')
   :stat('ACTIVE DEPARTMENT',state.selected.role,'Department-level access enabled')
    +stat('COMPANY',state.selected.company_code,'Isolated accounting tenant')
    +stat('ACCOUNT ACCESS','Restricted','No finance rights for this role')
    +stat('MODULES','Planned','Dealer management phases ahead');
  return '<div class="stat-grid">'+stats+'</div>'+
    '<div class="banner"><strong>Welcome to AQVORA Plus</strong> This development build implements real server-backed finance vouchers, balanced postings, reversals and reports. Sales, Service and Parts operations are being built in later milestones. Do not enter real dealership data yet.</div>'+
    (editor()?'<div class="card"><div class="card-head"><h2>Quick Actions</h2></div><div class="card-body"><div class="action-grid">'+
      '<button class="action-tile" data-page="new:JV"><strong>Create Journal Voucher</strong><small>Open →</small></button>'+
      '<button class="action-tile" data-page="vouchers"><strong>Review Vouchers</strong><small>Open →</small></button>'+
      '<button class="action-tile" data-page="trial"><strong>Generate Trial Balance</strong><small>Open →</small></button>'+
    '</div></div></div>':'');
}
function voucherRegister(){
  const rows=state.vouchers.map(v=>'<tr><td><strong>'+esc(v.number||'UNPOSTED')+'</strong></td><td>'+esc(v.type)+'</td><td>'+esc(v.date)+'</td><td>'+esc(v.department)+'</td><td class="wrap">'+esc(v.narrative)+'</td><td><span class="pill '+(v.status==='DRAFT'?'draft':'')+'">'+esc(v.status)+'</span></td><td><div class="inline-actions">'+
    '<button data-action="view" data-id="'+esc(v.id)+'">View</button>'+
    (v.status==='DRAFT'&&editor()?'<button data-action="post" data-id="'+esc(v.id)+'">Post</button>':'')+
    (v.status==='POSTED'&&editor()&&v.type!=='REV'?'<button data-action="reverse" data-id="'+esc(v.id)+'">Reverse</button>':'')+
    '</div></td></tr>');
  return '<div class="toolbar"><div class="muted small">Showing most recent 100 vouchers · Company-scoped</div>'+
    (editor()?'<div class="toolbar-right">'+button('New Journal Voucher','new-jv','','primary')+'</div>':'')+'</div>'+
    '<div class="card">'+table(['Voucher No.','Type','Date','Department','Narration','Status','Actions'],rows,'No vouchers in this company yet')+'</div>';
}
let lineCount=2;
function lineRow(i,values={}){
  const available=state.accounts.filter(a=>a.manual_entry_allowed!==false);
  const preferred=values.accountCode||available[i%available.length]?.code;
  const options=available.map(a=>'<option value="'+esc(a.code)+'" '+(preferred===a.code?'selected':'')+'>'+esc(a.code)+' — '+esc(a.name)+'</option>').join('');
  return '<tr><td>'+(i+1)+'</td><td><select aria-label="Line '+(i+1)+' account" class="line-account">'+options+'</select></td>'+
    '<td><input type="text" aria-label="Line '+(i+1)+' debit" class="line-debit" inputmode="decimal" value="'+esc(values.debit||'0')+'"/></td>'+
    '<td><input type="text" aria-label="Line '+(i+1)+' credit" class="line-credit" inputmode="decimal" value="'+esc(values.credit||'0')+'"/></td>'+
    '<td>'+button('×','remove-line','data-index="'+i+'"')+'</td></tr>';
}
function collectLines(){
  return [...document.querySelectorAll('#entry-lines tbody tr')].map(row=>({
    accountCode:row.querySelector('.line-account').value,
    debit:row.querySelector('.line-debit').value,credit:row.querySelector('.line-credit').value
  }));
}
function updateTotals(){
  const root=$('entry-lines');if(!root)return;
  let debits=0n,credits=0n,valid=true;
  collectLines().forEach(l=>{const d=parsePaisa(l.debit),c=parsePaisa(l.credit);if(d===null||c===null)valid=false;else{debits+=d;credits+=c;}});
  $('debit-total').textContent=valid?money(debits):'Invalid';
  $('credit-total').textContent=valid?money(credits):'Invalid';
  $('balance-state').textContent=valid?(debits===credits&&debits>0n?'Balanced':'Difference: '+money(debits-credits)):'Invalid amounts';
}
function newVoucher(){
  if(!editor())return '<div class="banner">This role does not allow voucher posting.</div>';
  if(!state.accounts.some(a=>a.manual_entry_allowed!==false))return '<div class="banner">There are no manual voucher accounts configured. Use the source-specific finance modules for AR, AP, inventory and tax postings.</div>';
  const type=state.page.slice(4);
  const typeOptions=documents.map(([t,label])=>'<option value="'+esc(t)+'" '+(t===type?'selected':'')+'>'+esc(label)+'</option>').join('');
  const departments=state.departments.map(d=>'<option value="'+esc(d.code)+'">'+esc(d.name)+'</option>').join('');
  return '<form id="voucher-form" class="card"><div class="card-head"><h2>Voucher Header</h2><span class="pill draft">DRAFT</span></div>'+
    '<div class="card-body"><div class="form-grid">'+
      '<div class="field"><label for="voucher-type">Voucher Type</label><select id="voucher-type">'+typeOptions+'</select></div>'+
      '<div class="field"><label for="voucher-date">Voucher Date</label><input id="voucher-date" type="date" value="'+today()+'" required/></div>'+
      '<div class="field"><label for="voucher-department">Cost Center / Department</label><select id="voucher-department">'+departments+'</select></div>'+
      '<div class="field wide"><label for="voucher-narrative">Narration</label><textarea id="voucher-narrative" required maxlength="2000" placeholder="Record a clear business purpose..."></textarea></div>'+
    '</div><div class="toolbar"><h3>Debit / Credit Lines</h3>'+button('+ Add Line','add-line')+'</div>'+
    '<div id="entry-lines" class="form-table">'+table(['#','Account','Debit (PKR)','Credit (PKR)',''],Array.from({length:lineCount},(_,i)=>lineRow(i)))+'</div>'+
    '<div class="totals"><div>Debits: <b id="debit-total">0.00</b></div><div>Credits: <b id="credit-total">0.00</b></div><span id="balance-state">—</span></div></div>'+
    '<div class="form-footer"><span class="muted small">A draft has no ledger impact until posted. Posted entries cannot be edited.</span><div class="toolbar-right">'+
      '<button class="secondary" type="submit" name="mode" value="draft">Save Draft</button>'+
      '<button class="primary" type="submit" name="mode" value="post">Save &amp; Post</button>'+
    '</div></div></form>';
}
function trial(){
  const rows=state.report.filter(x=>BigInt(x.balance_paisa)!==0n).map(r=>{
    const value=BigInt(r.balance_paisa);
    return '<tr><td>'+esc(r.code)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.kind)+'</td>'+
      '<td class="amount">'+(value>0n?money(value):'—')+'</td>'+
      '<td class="amount">'+(value<0n?money(-value):'—')+'</td></tr>';
  });
  const sumD=state.report.reduce((n,r)=>{const v=BigInt(r.balance_paisa);return v>0n?n+v:n;},0n);
  const sumC=state.report.reduce((n,r)=>{const v=BigInt(r.balance_paisa);return v<0n?n-v:n;},0n);
  return '<div class="toolbar"><div class="muted small">Posted journal entries only · All departments</div>'+button('Export CSV','csv-trial')+'</div>'+
    '<div class="card"><div class="card-head"><h2>Trial Balance</h2><span class="pill">'+(sumD===sumC?'BALANCED':'UNBALANCED')+'</span></div>'+
    table(['Account Code','Account Name','Classification','Debit (PKR)','Credit (PKR)'],rows)+
    '<div class="totals"><div>Debit: '+money(sumD)+'</div><div>Credit: '+money(sumC)+'</div></div></div>';
}
function ledger(){
  const selected=state.ledgerAccount||state.accounts[0]?.code||'';
  const options=state.accounts.map(a=>'<option value="'+esc(a.code)+'" '+(a.code===selected?'selected':'')+'>'+esc(a.code)+' — '+esc(a.name)+'</option>').join('');
  let running=0n;
  const rows=state.ledger.map(r=>{running+=BigInt(r.debit_paisa)-BigInt(r.credit_paisa);
    return '<tr><td>'+esc(r.voucher_number)+'</td><td>'+esc(r.voucher_date)+'</td><td class="wrap">'+esc(r.narrative)+'</td><td class="amount">'+money(r.debit_paisa)+'</td><td class="amount">'+money(r.credit_paisa)+'</td><td class="amount">'+money(running)+'</td></tr>';
  });
  return '<div class="card"><div class="card-head"><h2>Account Ledger</h2>'+button('Export CSV','csv-ledger')+'</div>'+
    '<div class="card-body"><div class="toolbar"><label>Account<select id="ledger-select">'+options+'</select></label>'+
    button('Generate','generate-ledger','','primary')+'</div></div>'+
    table(['Voucher No.','Date','Narration','Debit (PKR)','Credit (PKR)','Running Balance'],rows,'No posted entries for this account')+'</div>';
}
function audit(){
  const rows=state.audit.map(e=>'<tr><td>'+esc(e.action)+'</td><td>'+esc(e.entity_id)+'</td><td>'+esc(new Date(e.occurred_at).toLocaleString())+'</td></tr>');
  return '<div class="card"><div class="card-head"><h2>Recent Audit Events</h2></div>'+table(['Event','Document ID','Recorded At'],rows)+'</div>';
}
function detail(){
  if(!state.detail)return '<div class="banner">Loading voucher...</div>';
  const {voucher:v,lines}=state.detail;
  const rows=lines.map(l=>'<tr><td>'+esc(l.line_number)+'</td><td>'+esc(l.code)+'</td><td>'+esc(l.name)+'</td><td class="amount">'+money(l.debit_paisa)+'</td><td class="amount">'+money(l.credit_paisa)+'</td></tr>');
  return '<div class="toolbar">'+button('Back to Register','go-vouchers')+'</div>'+
    '<div class="card"><div class="card-head"><h2>'+esc(v.voucher_number||'Draft Voucher')+'</h2><span class="pill '+(v.status==='DRAFT'?'draft':'')+'">'+esc(v.status)+'</span></div>'+
    '<div class="card-body"><div class="detail-grid"><div><small>Type</small>'+esc(v.voucher_type)+'</div><div><small>Date</small>'+esc(v.date)+'</div><div><small>Reverses</small>'+esc(v.reverses_id||'—')+'</div></div>'+
    '<p class="muted small">Narration: '+esc(v.narrative)+'</p></div>'+
    table(['#','Account','Account Name','Debit (PKR)','Credit (PKR)'],rows)+'</div>';
}
function render(){
  if(!state.selected)return;
  const p=state.page;
  const found=navigation().find(x=>x.id===p)||(p==='detail'?{id:'detail',text:'Voucher Details',group:'Financials / Accounts'}:null);
  if(!found){state.page='dashboard';return render();}
  $('crumb').textContent=found.text;$('page-title').textContent=found.text;
  $('breadcrumb-section').textContent=found.group.toUpperCase();
  $('page-subtitle').textContent=p.startsWith('new:')?'Create a voucher with balanced debit and credit lines':'Dealership management workspace';
  renderNav();
  $('view').innerHTML=p==='dashboard'?dashboard():p==='vouchers'?voucherRegister():p.startsWith('new:')?newVoucher():p==='trial'?trial():p==='ledger'?ledger():p==='audit'?audit():p==='detail'?detail():p.startsWith('auto:')?window.AQVORA_AUTO.render(p,state.selected.role):p.startsWith('fin4:')?window.AQVORA_FIN4.render(p,state.selected.role):p.startsWith('phase5:')?window.AQVORA_PHASE5.render(p,state.selected.role):p.startsWith('phase6:')?window.AQVORA_PHASE6.render(p,state.selected.role):p.startsWith('phase7:')?window.AQVORA_PHASE7.render(p,state.selected.role):
    '<div class="banner"><strong>Planned feature — '+esc(found.text)+'</strong>This function is part of the Dealer Pro parity roadmap, but is not implemented in this development release.</div>';
  if(p.startsWith('new:'))updateTotals();
}
async function open(page){
  clearNotice();state.page=page;
  $('sidebar').classList.remove('open');$('overlay').classList.add('hidden');
  try{
    if(page==='trial')state.report=(await api('/api/reports/trial-balance')).rows;
    if(page==='ledger'){
      state.ledgerAccount=state.ledgerAccount||state.accounts[0]?.code;
      state.ledger=(await api('/api/reports/ledger?account='+encodeURIComponent(state.ledgerAccount))).rows;
    }
    if(page==='audit')state.audit=(await api('/api/audit')).events;
    if(page.startsWith('auto:'))await window.AQVORA_AUTO.load(page,api);
    if(page.startsWith('fin4:'))await window.AQVORA_FIN4.load(page,api);
    if(page.startsWith('phase5:'))await window.AQVORA_PHASE5.load(page,api);
    if(page.startsWith('phase6:'))await window.AQVORA_PHASE6.load(page,api);
    if(page.startsWith('phase7:'))await window.AQVORA_PHASE7.load(page,api);
  }catch(e){notify(e.message,true);}
  render();
}
async function saveVoucher(event){
  event.preventDefault();if(state.busy)return;
  state.busy=true;
  const submitter=event.submitter;
  try{
    const body={
      type:$('voucher-type').value,date:$('voucher-date').value,
      department:$('voucher-department').value,narrative:$('voucher-narrative').value,
      lines:collectLines()
    };
    const created=await post('/api/vouchers',body);
    let success='Draft saved. Review it in Voucher Register.';
    if(submitter?.value==='post'){
      try{
        const posted=await post('/api/vouchers/'+created.id+'/post',{});
        success=posted.number+' successfully posted to the ledger.';
      }catch(e){
        success='Draft saved, but posting failed: '+e.message+' — check the fiscal period.';
      }
    }
    state.vouchers=(await api('/api/vouchers')).vouchers;
    state.report=(await api('/api/reports/trial-balance')).rows;
    lineCount=2;await open('vouchers');notify(success);
  }catch(e){notify(e.message,true);}
  finally{state.busy=false;}
}
async function voucherAction(action,id){
  try{
    if(action==='view'){state.detail=await api('/api/vouchers/'+id);state.page='detail';render();return;}
    if(action==='post'){
      if(!confirm('Post this voucher permanently to General Ledger?'))return;
      const result=await post('/api/vouchers/'+id+'/post',{});
      await refresh();notify('Posted '+result.number);
      return;
    }
    if(action==='reverse'){
      const reason=prompt('Reason for reversal (required):');
      if(reason===null)return;
      if(!reason.trim())throw Error('Reversal reason required');
      const result=await post('/api/vouchers/'+id+'/reverse',{date:today(),reason});
      await refresh();notify('Reversal posted: '+result.number);
    }
  }catch(e){notify(e.message,true);}
}
function csv(rows,filename){
  const csvText='\uFEFF'+rows.map(r=>r.map(v=>{
    let value=String(v??'');
    if(/^[=+\-@\t\r]/.test(value))value="'"+value;
    return '"'+value.replaceAll('"','""')+'"';
  }).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csvText],{type:'text/csv;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();URL.revokeObjectURL(url);
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=new FormData(event.target);
  try{await post('/api/auth/login',{email:form.get('email'),password:form.get('password')});await refresh();$('login-error').textContent='';}
  catch(e){$('login-error').textContent=e.message;}
});
$('logout').addEventListener('click',async()=>{
  try{await post('/api/auth/logout',{});}catch{}
  showLogin();
});
$('company-select').addEventListener('change',async event=>{
  const selected=state.memberships.find(m=>m.company_id===event.target.value);
  if(!selected)return;
  state.selected=selected;state.page='dashboard';
  try{await refresh();clearNotice();}catch(e){notify(e.message,true);}
});
$('mobile-nav').addEventListener('click',()=>{$('sidebar').classList.add('open');$('overlay').classList.remove('hidden');});
$('overlay').addEventListener('click',()=>{
  $('sidebar').classList.remove('open');$('overlay').classList.add('hidden');
});
$('nav').addEventListener('click',event=>{
  const b=event.target.closest('[data-page]');if(b)open(b.dataset.page);
});
$('view').addEventListener('submit',event=>{
  if(event.target.id==='voucher-form')saveVoucher(event);
  if(event.target.id==='auto-form')window.AQVORA_AUTO.submit(event,{post,open,notify});
  if(event.target.id==='fin4-form')window.AQVORA_FIN4.submit(event,{post,open,notify});
  if(event.target.id==='phase5-form')window.AQVORA_PHASE5.submit(event,{post,open,notify});
  if(event.target.id==='phase6-form')window.AQVORA_PHASE6.submit(event,{post,open,notify});
  if(event.target.id==='phase7-form')window.AQVORA_PHASE7.submit(event,{post,open,notify});
});
$('view').addEventListener('input',event=>{if(event.target.closest('#entry-lines'))updateTotals();});
$('view').addEventListener('click',async event=>{
  const link=event.target.closest('[data-page]');if(link){open(link.dataset.page);return;}
  const b=event.target.closest('[data-action]');if(!b)return;
  const act=b.dataset.action;
  if(act.startsWith('auto:')){await window.AQVORA_AUTO.act(act.slice(5),b.dataset.id,{post,open,notify});return;}
  if(act.startsWith('fin4:')){await window.AQVORA_FIN4.act(act.slice(5),b.dataset.id,{post,open,notify});return;}
  if(act.startsWith('phase6:')){await window.AQVORA_PHASE6.act(act.slice(7),b.dataset.id,{post,open,notify});return;}
  if(act.startsWith('phase7:')){await window.AQVORA_PHASE7.act(act.slice(7),b.dataset.id,{post,open,notify});return;}
  if(['view','post','reverse'].includes(act)){await voucherAction(act,b.dataset.id);return;}
  if(act==='new-jv'){await open('new:JV');return;}
  if(act==='go-vouchers'){await open('vouchers');return;}
  if(act==='add-line'){
    const lines=collectLines();lineCount=Math.min(100,lines.length+1);
    $('entry-lines').querySelector('tbody').innerHTML=lines.concat({accountCode:state.accounts[0]?.code,debit:'0',credit:'0'}).map((l,i)=>lineRow(i,l)).join('');
    updateTotals();return;
  }
  if(act==='remove-line'){
    const lines=collectLines();if(lines.length<=2){notify('At least two lines required',true);return;}
    lines.splice(Number(b.dataset.index),1);lineCount=lines.length;
    $('entry-lines').querySelector('tbody').innerHTML=lines.map((l,i)=>lineRow(i,l)).join('');
    updateTotals();return;
  }
  if(act==='generate-ledger'){
    state.ledgerAccount=$('ledger-select').value;
    try{state.ledger=(await api('/api/reports/ledger?account='+encodeURIComponent(state.ledgerAccount))).rows;render();}
    catch(e){notify(e.message,true);}return;
  }
  if(act==='csv-trial'){
    csv([['Code','Account','Kind','Debit paisa','Credit paisa'],...state.report.map(r=>{
      const value=BigInt(r.balance_paisa);
      return [r.code,r.name,r.kind,String(value>0n?value:0n),String(value<0n?-value:0n)];
    })],'aqvora-plus-trial-balance.csv');return;
  }
  if(act==='csv-ledger'){
    csv([['Voucher','Date','Narrative','Debit paisa','Credit paisa'],...state.ledger.map(r=>[
      r.voucher_number,r.voucher_date,r.narrative,r.debit_paisa,r.credit_paisa
    ])],'aqvora-plus-general-ledger.csv');
  }
});
(async()=>{try{await refresh();}catch{showLogin();}})();

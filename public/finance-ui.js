/* AQVORA Plus Phase 4 — finance and stock control screens. Server enforces authorization. */
(function(){
'use strict';
const data={};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=p=>{const n=BigInt(p||0),abs=n<0n?-n:n;return (n<0n?'-':'')+(abs/100n).toLocaleString('en-PK')+'.'+String(abs%100n).padStart(2,'0');};
const td=x=>'<td>'+esc(x)+'</td>';
const amt=x=>'<td class="amount">'+fmt(x)+'</td>';
const rows=(headers,values,empty='No records yet')=>'<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+(values.length?values.join(''):'<tr><td colspan="'+headers.length+'" class="empty">'+esc(empty)+'</td></tr>')+'</tbody></table></div>';
const card=(heading,html)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(heading)+'</h2></div>'+html+'</div>';
const date=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
const field=(label,name,placeholder='',type='text',required=true,value='')=>'<div class="field"><label>'+esc(label)+'</label><input name="'+esc(name)+'" type="'+type+'" placeholder="'+esc(placeholder)+'" value="'+esc(value)+'" '+(required?'required':'')+' /></div>';
const select=(label,name,arr,value,makeLabel,placeholder='Select...',required=true)=>
 '<div class="field"><label>'+esc(label)+'</label><select name="'+esc(name)+'" '+(required?'required':'')+'><option value="">'+esc(placeholder)+'</option>'+arr.map(x=>'<option value="'+esc(x[value])+'">'+esc(makeLabel(x))+'</option>').join('')+'</select></div>';
const form=(kind,title,fields)=>'<form id="fin4-form" data-kind="'+esc(kind)+'" class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(title)+'</h2></div><div class="card-body"><div class="form-grid">'+fields.join('')+'</div></div><div class="form-footer"><span class="muted small">Posted immediately · Cannot be edited or deleted</span><button type="submit" class="primary">Validate & Post</button></div></form>';
const action=(label,act,id)=>'<button type="button" class="secondary" data-action="fin4:'+esc(act)+'" data-id="'+esc(id)+'">'+esc(label)+'</button>';
const write=role=>role==='ADMIN'||role==='FINANCE';
async function load(page,api){
 const pages={
  'fin4:suppliers':['/api/finance4/suppliers'],
  'fin4:purchases':['/api/finance4/suppliers','/api/finance4/purchases','/api/auto/parts'],
  'fin4:sales':['/api/auto/sales/bookings','/api/finance4/sales-invoices','/api/phase5/tax-codes'],
  'fin4:parts':['/api/auto/parts','/api/auto/service/jobs','/api/auto/stock-movements'],
  'fin4:reconciliation':['/api/reports/reconciliation']
 };
 for(const key of (pages[page]||[])){
   const response=await api(key);
   data[key]=response;
 }
 data.current=page;
}
function suppliers(role){
 const ss=data['/api/finance4/suppliers']?.suppliers||[];
 const create=write(role)?form('supplier','Register Supplier',[field('Supplier name','name','Supplier legal name'),field('Phone','phone','Optional','tel',false)]):'';
 return create+card('Suppliers',rows(['Supplier','Contact'],ss.map(s=>'<tr>'+td(s.name)+td(s.phone||'—')+'</tr>')));
}
function purchases(role){
 const ss=data['/api/finance4/suppliers']?.suppliers||[],bill=data['/api/finance4/purchases']?.purchases||[];
 const parts=data['/api/auto/parts']?.parts||[];
 const header='<div class="banner"><strong>Accounted procurement</strong> Purchase posting immediately debits Vehicle or Parts Inventory and credits Accounts Payable. A supplier invoice number may be used only once per supplier. Existing legacy stock is not automatically valued.</div>';
 let create='';
 if(write(role)){
  const common=[select('Supplier','supplierId',ss,'id',x=>x.name),
    field('Supplier Invoice No.','supplierInvoiceNo','Vendor bill number'),
    field('Invoice Date','date','','date',true,date()),
    field('Due Date','dueDate','','date',true,date())];
  create=form('vehicle-purchase','Post Vehicle Acquisition',[
    ...common,field('Chassis','chassis','VIN / chassis'),
    field('Variant','variant','Model / variant'),field('Colour','color','Optional','text',false),
    field('List Price (PKR)','listPrice','Customer selling price'),
    field('Purchase Cost (PKR)','cost','Supplier cost')]);
  create+=form('parts-purchase','Post Parts Purchase (Stock + AP)',[
    ...common,select('Part','partId',parts,'id',x=>x.sku+' — '+x.name),
    field('Quantity','quantity','Quantity','number'),
    field('Unit Cost (PKR)','unitCost','Actual supplier unit cost')]);
 }
 return header+create+card('Accounts Payable / Supplier Bills',rows(['Doc No.','Supplier','Vendor Invoice','Type','Invoice Date','Amount (PKR)','Outstanding','Action'],
   bill.map(x=>'<tr>'+td(x.reference)+td(x.supplier_name)+td(x.supplier_invoice_no)+td(x.bill_type)+td(x.invoice_date)+amt(x.amount_paisa)+amt(x.outstanding_paisa)+'<td>'+
     (write(role)&&BigInt(x.outstanding_paisa)>0n?action('Pay Supplier','supplier-payment',x.id):'—')+'</td></tr>')));
}
function sales(role){
 const bookings=data['/api/auto/sales/bookings']?.bookings||[];
 const invoices=data['/api/finance4/sales-invoices']?.invoices||[];
 const codes=data['/api/phase5/tax-codes']?.codes||[];
 const issued=new Set(invoices.map(x=>x.booking_reference));
 const available=bookings.filter(x=>x.status==='BOOKED'&&!issued.has(x.reference));
 const create=write(role)?form('vehicle-sale','Post Booked Vehicle Sales Invoice',[
   select('Booked vehicle','bookingId',available,'id',x=>x.reference+' / '+x.customer_name+' / '+x.chassis,'Select booked vehicle'),
   field('Invoice Date','date','','date',true,date()),
   field('Due Date','dueDate','','date',true,date()),
   select('Sales tax code','taxCode',codes,'code',x=>x.code+' / '+(x.rate_bps/100).toFixed(2)+'%','No configured tax code',false)
 ]):'';
 return '<div class="banner"><strong>Financially posted vehicle sale</strong> Invoice recognizes A/R and sales revenue, and separately posts vehicle COGS / inventory reduction. Only vehicles acquired through an accounted procurement can be sold. This does not yet complete registration or legal delivery documentation.</div>'+
   create+card('Vehicle Sales Invoices',rows(['Invoice','Booking','Customer','Chassis','Revenue (PKR)','Sales Tax','Cost (PKR)','Outstanding','Action'],
   invoices.map(x=>'<tr>'+td(x.reference)+td(x.booking_reference)+td(x.customer_name)+td(x.chassis)+amt(x.sales_amount_paisa)+amt(x.sales_tax_paisa)+amt(x.cogs_paisa)+amt(x.outstanding_paisa)+'<td>'+
     (write(role)&&BigInt(x.outstanding_paisa)>0n?action('Collect','sale-collection',x.id):'—')+'</td></tr>')));
}
function parts(role){
 const parts=data['/api/auto/parts']?.parts||[],jobs=data['/api/auto/service/jobs']?.jobs||[];
 const movements=data['/api/auto/stock-movements']?.movements||[];
 const accounted=parts.filter(x=>x.valuation_mode==='POSTED');
 const open=jobs.filter(x=>x.status!=='COMPLETED');
 const create=write(role)?form('accounted-issue','Post Accounted Parts Issue / COGS',[
   select('Accounted part','partId',accounted,'id',x=>x.sku+' / '+x.stock_qty+' available'),
   select('Open service job','jobId',open,'id',x=>x.reference+' / '+x.registration),
   field('Quantity','quantity','Whole units','number'),
   field('Issue Reference','reference','Unique issue document'),
   field('Posting Date','date','','date',true,date())
 ]):'';
 const partRows=parts.map(x=>'<tr>'+td(x.sku)+td(x.name)+td(x.valuation_mode||'LEGACY')+td(x.stock_qty)+amt(x.inventory_value_paisa||0)+'</tr>');
 const moveRows=movements.map(x=>'<tr>'+td(x.reference)+td(x.sku)+td(x.direction)+td(x.quantity)+amt(x.unit_cost_paisa)+'</tr>');
 return '<div class="banner"><strong>Moving weighted-average inventory value</strong> Accounted issues debit Parts Consumption/COGS and credit Parts Inventory. Legacy operational movements remain unposted and cannot be mixed with accounted stock until reconciled.</div>'+
   create+card('Parts Inventory Value',rows(['SKU','Part','Valuation Mode','Qty','Carrying Value (PKR)'],partRows))+
   card('Recent Stock Movements',rows(['Document','Part','Type','Qty','Unit Cost'],moveRows));
}
function reconciliation(){
 const d=data['/api/reports/reconciliation'];
 if(!d)return '';
 const status=d.reconciled?'RECONCILED':'REVIEW REQUIRED';
 const checks=d.checks||[];
 const legacy=d.unresolved_legacy||{};
 return '<div class="banner"><strong>'+esc(status)+'</strong>Subledgers compared with posted General Ledger control balances. Differences may come from manual account postings or unaccounted legacy stock. This is not a certified financial audit.</div>'+
   card('Control Account Reconciliation',rows(['Account','Expected subledger (PKR)','Posted GL (PKR)','Difference (PKR)','Result'],
   checks.map(x=>'<tr>'+td(x.name)+amt(x.expected_paisa)+amt(x.gl_paisa)+amt(x.difference_paisa)+td(x.matched?'MATCH':'DIFFERENCE')+'</tr>')))+
   card('Unreconciled Legacy Items','<div class="card-body"><p>Legacy vehicle stock: <strong>'+esc(legacy.vehicles||0)+'</strong></p><p>Legacy parts stock: <strong>'+esc(legacy.parts||0)+'</strong></p><p class="muted small">'+esc(d.note||'')+'</p></div>');
}
function render(page,role){
 if(page==='fin4:suppliers')return suppliers(role);
 if(page==='fin4:purchases')return purchases(role);
 if(page==='fin4:sales')return sales(role);
 if(page==='fin4:parts')return parts(role);
 if(page==='fin4:reconciliation')return reconciliation();
 return '<div class="banner">Unrecognized finance screen.</div>';
}
async function submit(event,{post,open,notify}){
 event.preventDefault();
 const f=event.target,kind=f.dataset.kind,fd=Object.fromEntries(new FormData(f).entries());
 const routes={
  'supplier':'/api/finance4/suppliers',
  'vehicle-purchase':'/api/finance4/purchases/vehicle',
  'parts-purchase':'/api/finance4/purchases/parts',
  'vehicle-sale':'/api/finance4/sales-invoices',
  'accounted-issue':'/api/finance4/parts/issue'
 };
 if(!routes[kind])return;
 if(kind==='parts-purchase'||kind==='accounted-issue')fd.quantity=Number(fd.quantity);
 const button=f.querySelector('button[type=submit]');
 button.disabled=true;
 try{const result=await post(routes[kind],fd);await open(data.current);notify('Posted successfully: '+(result.reference||result.journal||result.name||'Document created'));}
 catch(e){notify(e.message,true);}
 finally{button.disabled=false;}
}
async function act(what,id,{post,open,notify}){
 if(!['supplier-payment','sale-collection'].includes(what))return;
 const amount=prompt('Payment amount in PKR (e.g. 1000.00)');
 if(amount===null)return;
 const paymentDate=prompt('Payment date (YYYY-MM-DD)',date());
 if(paymentDate===null)return;
 if(!confirm('Post this payment permanently to General Ledger?'))return;
 const route=what==='supplier-payment'?'/api/finance4/purchases/'+id+'/payments':'/api/finance4/sales-invoices/'+id+'/payments';
 try{
  const r=await post(route,{amount,date:paymentDate,clientKey:crypto.randomUUID()});
  await open(data.current);notify('Payment posted to '+r.journal);
 }catch(e){notify(e.message,true);}
}
window.AQVORA_FIN4={load,render,submit,act};
})();

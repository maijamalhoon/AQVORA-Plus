/* AQVORA Plus Phase 5. All writes are checked and audited by the server. */
(function(){
'use strict';
const cache={};
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=v=>{const n=BigInt(v||0),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n).toLocaleString('en-PK')+'.'+String(a%100n).padStart(2,'0');};
const td=v=>'<td>'+safe(v)+'</td>';
const moneyTd=v=>'<td class="amount">'+amount(v)+'</td>';
const table=(headers,records)=>'<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+safe(h)+'</th>').join('')+'</tr></thead><tbody>'+(records.length?records.join(''):'<tr><td colspan="'+headers.length+'" class="empty">No records</td></tr>')+'</tbody></table></div>';
const card=(heading,content)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+safe(heading)+'</h2></div>'+content+'</div>';
const box=text=>'<div class="banner">'+text+'</div>';
const date=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
const inp=(name,label,type='text',value='',required=true)=>'<div class="field"><label>'+safe(label)+'</label><input name="'+safe(name)+'" type="'+type+'" value="'+safe(value)+'" '+(required?'required':'')+'/></div>';
const select=(name,label,items,makeLabel,placeholder='Select')=>
 '<div class="field"><label>'+safe(label)+'</label><select name="'+safe(name)+'" required><option value="">'+safe(placeholder)+'</option>'+
 items.map(i=>'<option value="'+safe(i.id)+'">'+safe(makeLabel(i))+'</option>').join('')+'</select></div>';
const form=(kind,label,inputs,caption='All writes create auditable company-scoped records')=>'<form id="phase5-form" data-kind="'+safe(kind)+'" class="card" style="margin-bottom:18px">'+
 '<div class="card-head"><h2>'+safe(label)+'</h2></div><div class="card-body"><div class="form-grid">'+inputs.join('')+'</div></div>'+
 '<div class="form-footer"><span class="muted small">'+safe(caption)+'</span><button type="submit" class="primary">Validate & Save</button></div></form>';
const names={
 'phase5:tax':[['codes','/api/phase5/tax-codes']],
 'phase5:returns':[['purchases','/api/finance4/purchases'],['returns','/api/phase5/purchase-returns']],
 'phase5:credits':[['invoices','/api/finance4/sales-invoices'],['notes','/api/phase5/credit-notes']],
 'phase5:deliveries':[['invoices','/api/finance4/sales-invoices'],['deliveries','/api/phase5/deliveries']],
 'phase5:ap':[['ap','/api/phase5/reports/ap-aging']],
 'phase5:tax-report':[['tax','/api/phase5/reports/tax-summary']],
 'phase5:margin':[['margin','/api/phase5/reports/sales-margin']]
};
async function load(page,api){
 for(const [name,url] of (names[page]||[]))cache[name]=await api(url);
 cache.page=page;
}
function render(page,role){
 if(page==='phase5:tax'){
  const codes=cache.codes?.codes||[];
  const create=role==='ADMIN'?form('tax','Register Company Tax Code',[
   inp('code','Unique code (e.g. TAX_1800)'),inp('name','Description'),
   inp('rateBps','Rate in basis points (1800 means 18%)','number','0')
  ],'Rates are immutable and must be verified for the applicable tax jurisdiction'):'';
  return box('<strong>Tax setup</strong>No default statutory rate is assumed. Create a separate tax code for every verified new rate; historical invoices retain the rate snapshot.')+
    create+card('Configured Tax Codes',table(['Code','Description','Rate (%)'],codes.map(x=>'<tr>'+td(x.code)+td(x.name)+td((x.rate_bps/100).toFixed(2)+'%')+'</tr>')));
 }
 if(page==='phase5:returns'){
  const bills=(cache.purchases?.purchases||[]).filter(x=>x.bill_type==='PARTS'&&x.quantity>x.returned_qty&&BigInt(x.outstanding_paisa)>0n);
  const returns=cache.returns?.returns||[];
  return box('<strong>Parts supplier returns</strong>Vendor credit reduces AP, stock quantity and inventory carrying value. Any moving-average cost difference goes to Purchase Price Variance. Refunds on already paid bills are not yet supported.')+
   form('return','Record Supplier Parts Return',[
    select('billId','Accounted supplier bill',bills,x=>x.reference+' / '+x.supplier_name+' / '+(x.quantity-x.returned_qty)+' unreturned'),
    inp('quantity','Quantity to return','number','1'),inp('date','Return date','date',date()),
    inp('reason','Return reason')
   ],'Supplier credit and GL inventory entry are posted atomically')+
   card('Purchase Return Register',table(['Return','Source Bill','Part','Date','Qty','Supplier Credit','Inventory Cost','Variance'],
     returns.map(x=>'<tr>'+td(x.reference)+td(x.bill_reference)+td(x.sku)+td(x.return_date)+td(x.quantity)+moneyTd(x.supplier_credit_paisa)+moneyTd(x.inventory_cost_paisa)+moneyTd(x.variance_paisa)+'</tr>')));
 }
 if(page==='phase5:credits'){
  const invoices=(cache.invoices?.invoices||[]).filter(x=>BigInt(x.outstanding_paisa)>0n&&BigInt(x.sales_amount_paisa)>BigInt(x.credited_net_paisa));
  const notes=cache.notes?.notes||[];
  return box('<strong>Sales price-adjustment credit notes</strong>Only the unpaid amount may be credited, with proportional reversal of configured sales tax. This is NOT a physical vehicle return or customer refund.')+
   form('credit','Issue Vehicle Price Credit Note',[
    select('invoiceId','Vehicle sales invoice',invoices,x=>x.reference+' / '+x.customer_name+' / Open PKR '+amount(x.outstanding_paisa)),
    inp('netAmount','Net amount to credit (PKR)','text'),
    inp('date','Credit note date','date',date()),inp('reason','Reason for price credit')
   ])+
   card('Credit Note Register',table(['Credit Note','Vehicle Invoice','Date','Net Credit (PKR)','Tax Reversal','Reason'],
    notes.map(x=>'<tr>'+td(x.reference)+td(x.invoice_reference)+td(x.issued_on)+moneyTd(x.net_paisa)+moneyTd(x.tax_paisa)+td(x.reason)+'</tr>')));
 }
 if(page==='phase5:deliveries'){
  const all=cache.invoices?.invoices||[],delivered=cache.deliveries?.deliveries||[];
  const fulfilled=new Set(delivered.map(x=>x.invoice_reference));
  const eligible=all.filter(x=>!fulfilled.has(x.reference)&&BigInt(x.outstanding_paisa)===0n&&BigInt(x.sales_amount_paisa)>BigInt(x.credited_net_paisa));
  const create=['ADMIN','SALES'].includes(role)?form('deliver','Confirm Vehicle Handover',[
    select('invoiceId','Fully settled vehicle invoice',eligible,x=>x.reference+' / '+x.customer_name+' / '+x.chassis),
    inp('date','Handover date','date',date()),
    inp('recipient','Received by'),inp('odometerKm','Odometer reading (KM)','number','0'),inp('notes','Handover notes (optional)','text','',false)
   ],'Handover register only; legal delivery, registration and insurance remain separate'):'';
  return box('<strong>Vehicle delivery register</strong>Only fully settled, non-fully-credited invoices qualify. Handover is unique per invoice and cannot be edited/deleted.')+
    create+card('Vehicle Handover Records',table(['Delivery No.','Sales Invoice','Customer','Chassis','Handover Date','Recipient','KM'],
       delivered.map(x=>'<tr>'+td(x.reference)+td(x.invoice_reference)+td(x.customer_name)+td(x.chassis)+td(x.delivered_on)+td(x.recipient)+td(x.odometer_km)+'</tr>')));
 }
 if(page==='phase5:ap'){
  const bills=cache.ap?.rows||[];
  const total=bills.reduce((sum,x)=>sum+BigInt(x.outstanding_paisa),0n);
  return box('<strong>AP Aging</strong>Current unpaid supplier bills only, net of posted purchase returns and supplier payments.')+
    card('Outstanding Supplier Payables','<div class="card-body"><h2>PKR '+amount(total)+'</h2></div>'+
      table(['Bill','Supplier','Type','Due','Overdue Days','Outstanding'],bills.map(x=>'<tr>'+td(x.reference)+td(x.supplier_name)+td(x.bill_type)+td(x.due_date)+td(x.days_overdue)+moneyTd(x.outstanding_paisa)+'</tr>')));
 }
 if(page==='phase5:tax-report'){
  const t=cache.tax||{};
  return box('<strong>Tax control report</strong>Sales tax accrual based on explicitly configured codes. Not a statutory return or net liability after tax payments.')+
    card('Sales Tax Summary',table(['Metric','Amount (PKR)'],[
     '<tr>'+td('Tax initially charged')+moneyTd(t.issued_paisa)+'</tr>',
     '<tr>'+td('Tax reversed via credit notes')+moneyTd(t.credited_paisa)+'</tr>',
     '<tr>'+td('Expected outstanding tax accrual')+moneyTd(t.net_paisa)+'</tr>',
     '<tr>'+td('Posted tax GL balance')+moneyTd(t.gl_paisa)+'</tr>',
     '<tr>'+td('GL / source difference')+moneyTd(t.difference_paisa)+'</tr>'
    ]))+
    box('<strong>Control status:</strong> '+(t.reconciled?'MATCHED':'REQUIRES REVIEW'));
 }
 if(page==='phase5:margin'){
  const v=cache.margin||{},tot=v.totals||{};
  const records=v.rows||[];
  return box('<strong>Vehicle Sales Gross Margin</strong>Excludes tax, subtracts vehicle COGS and price-adjustment credits; does not include overheads, taxes/fees, workshop or parts revenue.')+
   '<div class="stat-grid">'+[
     ['NET VEHICLE REVENUE',tot.net_sales_paisa],['VEHICLE COGS',tot.cogs_paisa],['GROSS MARGIN',tot.gross_margin_paisa],['ISSUED INVOICES',tot.invoices]
   ].map(([name,value])=>'<div class="card stat"><span class="stat-kicker">'+safe(name)+'</span><strong class="stat-value">'+(name==='ISSUED INVOICES'?safe(value):'PKR '+amount(value))+'</strong></div>').join('')+'</div>'+
   card('Recent Vehicle Sales (up to 200)',table(['Invoice','Customer','Date','Net Sale','Price Credits','COGS','Gross Margin','Delivered'],records.map(x=>
     '<tr>'+td(x.reference)+td(x.customer_name)+td(x.invoice_date)+moneyTd(x.sales_amount_paisa)+moneyTd(x.credited_net_paisa)+moneyTd(x.cogs_paisa)+moneyTd(x.gross_margin_paisa)+td(x.delivered?'Yes':'No')+'</tr>')));
 }
 return box('<strong>Not available</strong>');
}
async function submit(event,{post,open,notify}){
 event.preventDefault();
 const el=event.target,kind=el.dataset.kind,data=Object.fromEntries(new FormData(el).entries());
 const urls={tax:'/api/phase5/tax-codes',return:'/api/phase5/purchase-returns',credit:'/api/phase5/credit-notes',deliver:'/api/phase5/deliveries'};
 if(!urls[kind])return;
 if(kind==='return')data.quantity=Number(data.quantity);
 if(kind==='tax')data.rateBps=Number(data.rateBps);
 if(kind==='deliver')data.odometerKm=Number(data.odometerKm);
 if(kind==='return'||kind==='credit')data.clientKey=crypto.randomUUID();
 const button=el.querySelector('button[type=submit]');button.disabled=true;
 try{
  const result=await post(urls[kind],data);
  await open(cache.page);
  notify('Saved: '+(result.reference||result.code||result.id||'Document created'));
 }catch(e){notify(e.message,true);}finally{button.disabled=false;}
}
window.AQVORA_PHASE5={load,render,submit};
})();
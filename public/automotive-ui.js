/* Original AQVORA Plus operational screens: no third-party assets or client-side financial authority. */
(function(){
  'use strict';
  const state={};
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=v=>{
    const n=BigInt(v??0), a=n<0n?-n:n;
    return (n<0n?'-':'')+(a/100n).toLocaleString('en-PK')+'.'+String(a%100n).padStart(2,'0');
  };
  const col=x=>'<td>'+esc(x)+'</td>';
  const amount=x=>'<td class="amount">'+format(x)+'</td>';
  const tbody=(head,rows,empty='No records yet')=>'<div class="table-wrap"><table><thead><tr>'+head.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td class="empty" colspan="'+head.length+'">'+esc(empty)+'</td></tr>')+'</tbody></table></div>';
  const action=(label,verb,id)=>'<button type="button" class="secondary" data-action="auto:'+esc(verb)+'" data-id="'+esc(id)+'">'+esc(label)+'</button>';
  const options=(arr,value,label,placeholder)=>'<option value="">'+esc(placeholder)+'</option>'+arr.map(x=>'<option value="'+esc(x[value])+'">'+esc(label(x))+'</option>').join('');
  const form=(mode,fields,label)=>'<form id="auto-form" data-mode="'+esc(mode)+'" class="card"><div class="card-head"><h2>'+esc(label)+'</h2></div><div class="card-body"><div class="form-grid">'+fields.join('')+'</div></div><div class="form-footer"><span class="muted small">Validated by the server · Company scoped</span><button class="primary" type="submit">Save</button></div></form>';
  const field=(label,name,placeholder='',type='text',required=true,value='')=>
    '<div class="field"><label>'+esc(label)+'</label><input name="'+esc(name)+'" type="'+type+'" placeholder="'+esc(placeholder)+'" value="'+esc(value)+'" '+(required?'required':'')+'/></div>';
  const pick=(label,name,content,required=true)=>'<div class="field"><label>'+esc(label)+'</label><select name="'+esc(name)+'" '+(required?'required':'')+'>'+content+'</select></div>';
  const subhead=text=>'<div class="toolbar"><span class="muted small">'+esc(text)+'</span></div>';
  const roleCan=(roles,role)=>roles.includes(role);
  const card=(heading,body)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+esc(heading)+'</h2></div>'+body+'</div>';
  const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
  async function load(page,api){
    const paths={
      'auto:customers':['customers'],
      'auto:customer-vehicles':['customers','customer-vehicles'],
      'auto:vehicle-stock':['vehicle-stock'],
      'auto:sales-bookings':['customers','vehicle-stock','sales/bookings'],
      'auto:service-jobs':['customer-vehicles','service/jobs'],
      'auto:parts':['parts'],
      'auto:stock-movements':['parts','service/jobs','stock-movements'],
      'auto:service-invoices':['service/jobs','service/invoices'],
      'auto:ar-aging':['reports/ar-aging']
    };
    const items=paths[page]||[];
    const payload=await Promise.all(items.map(x=>api(x==='reports/ar-aging'?'/api/reports/ar-aging':'/api/auto/'+x)));
    items.forEach((x,i)=>state[x]=payload[i][Object.keys(payload[i]).find(k=>Array.isArray(payload[i][k]))]||[]);
    state.page=page;
  }
  function render(page,role){
    const customers=state.customers||[],customerVehicles=state['customer-vehicles']||[];
    const stock=state['vehicle-stock']||[],bookings=state['sales/bookings']||[];
    const jobs=state['service/jobs']||[],parts=state.parts||[];
    const moves=state['stock-movements']||[],invoices=state['service/invoices']||[];
    switch(page){
      case 'auto:customers':{
        const rows=customers.map(c=>'<tr>'+col(c.name)+col(c.phone||'—')+col(c.email||'—')+col(new Date(c.created_at).toLocaleDateString())+'</tr>');
        const create=roleCan(['ADMIN','SALES','SERVICE'],role)?form('customer',[
          field('Customer name','name','Enter full name'),
          field('Phone','phone','Optional','tel',false),
          field('Email','email','Optional','email',false)
        ],'Create Customer'):'';
        return create+card('Customer Register',tbody(['Name','Phone','Email','Created'],rows));
      }
      case 'auto:customer-vehicles':{
        const rows=customerVehicles.map(v=>'<tr>'+col(v.registration)+col(v.model)+col(v.chassis)+col(v.customer_name)+'</tr>');
        const create=roleCan(['ADMIN','SERVICE'],role)?form('customer-vehicle',[
          pick('Customer','customerId',options(customers,'id',x=>x.name,'Select customer')),
          field('Registration','registration','ABC-123'),
          field('Chassis','chassis','Unique chassis number'),
          field('Model','model','Model and variant')
        ],'Register Customer Vehicle'):'';
        return create+card('Customer Vehicles',tbody(['Registration','Model','Chassis','Customer'],rows));
      }
      case 'auto:vehicle-stock':{
        const rows=stock.map(v=>'<tr>'+col(v.chassis)+col(v.variant)+col(v.color||'—')+amount(v.list_price_paisa)+col(v.status)+'</tr>');
        const create=roleCan(['ADMIN','SALES'],role)?form('vehicle-stock',[
          field('Chassis','chassis','Unique VIN / chassis'),
          field('Variant','variant','Toyota model / variant'),
          field('Colour','color','Optional','text',false),
          field('List Price (PKR)','price','0.00')
        ],'Add Stock Vehicle'):'';
        return create+card('Vehicle Stock Register',tbody(['Chassis','Variant','Colour','List Price','Availability'],rows));
      }
      case 'auto:sales-bookings':{
        const rows=bookings.map(b=>'<tr>'+col(b.reference)+col(b.customer_name)+col(b.variant+' / '+b.chassis)+amount(b.agreed_price_paisa)+col(b.status)+'<td>'+(b.status==='BOOKED'&&roleCan(['ADMIN','SALES'],role)?action('Cancel booking','cancel-booking',b.id):'—')+'</td></tr>');
        const free=stock.filter(v=>v.status==='IN_STOCK');
        const create=roleCan(['ADMIN','SALES'],role)?form('sales-booking',[
          pick('Customer','customerId',options(customers,'id',x=>x.name,'Select customer')),
          pick('Available vehicle','vehicleId',options(free,'id',x=>x.variant+' / '+x.chassis,'Select stock vehicle')),
          field('Agreed Price (PKR)','price','0.00')
        ],'Create Sales Booking'):'';
        return '<div class="banner"><strong>Reservations only</strong> Booking reserves a stock vehicle. It does not issue a sales invoice, transfer ownership, or recognize revenue. Delivery and COGS are future milestones.</div>'+
          create+card('Sales Booking Register',tbody(['Booking','Customer','Stock Vehicle','Price','Status','Action'],rows));
      }
      case 'auto:service-jobs':{
        const rows=jobs.map(j=>'<tr>'+col(j.reference)+col(j.customer_name)+col(j.registration)+col(j.complaint)+col(j.status)+'<td>'+
          (roleCan(['ADMIN','SERVICE'],role)?(j.status==='OPEN'?action('Start','status-IN_PROGRESS',j.id):j.status==='IN_PROGRESS'?action('Complete','status-COMPLETED',j.id):'—'):'—')+'</td></tr>');
        const create=roleCan(['ADMIN','SERVICE'],role)?form('service-job',[
          pick('Customer vehicle','vehicleId',options(customerVehicles,'id',x=>x.registration+' / '+x.customer_name,'Select registered vehicle')),
          field('Customer complaint','complaint','Describe service request')
        ],'Create Job Card'):'';
        return create+card('Workshop Job Cards',tbody(['Job No.','Customer','Registration','Complaint','Status','Action'],rows));
      }
      case 'auto:parts':{
        const rows=parts.map(p=>'<tr>'+col(p.sku)+col(p.name)+col(p.stock_qty)+amount(p.unit_cost_paisa)+'</tr>');
        const create=roleCan(['ADMIN','PARTS'],role)?form('part',[
          field('Part SKU','sku','Unique part number'),field('Part name','name','Part description')
        ],'Add Part Master'):'';
        return create+card('Spare Parts Catalogue',tbody(['SKU','Description','On Hand','Last Receipt Cost (PKR)'],rows));
      }
      case 'auto:stock-movements':{
        const rows=moves.map(m=>'<tr>'+col(m.reference)+col(m.sku)+col(m.direction)+col(m.quantity)+amount(m.unit_cost_paisa)+col(m.job_reference||'—')+'</tr>');
        const editable=roleCan(['ADMIN','PARTS'],role);
        const create=editable?form('stock-movement',[
          pick('Part','partId',options(parts,'id',x=>x.sku+' / Qty '+x.stock_qty,'Select part')),
          pick('Movement','direction','<option value="RECEIPT">GRN / Stock Receipt</option><option value="ISSUE">Service Parts Issue</option>'),
          field('Quantity','quantity','Positive whole number','number'),
          field('Document Reference','reference','GRN / Job document number'),
          field('Unit Cost (PKR, receipts only)','unitCost','For receipt use actual cost','text',false),
          pick('Service Job (required for issues)','jobId',options(jobs.filter(x=>x.status!=='COMPLETED'),'id',x=>x.reference,'No job / receipt'),false)
        ],'Record Stock Movement'):'';
        return '<div class="banner"><strong>Stock ledger only</strong> Receipts increase available quantity, and issues to open service jobs decrease it. Inventory GL valuation, supplier payable and cost of sales posting are not implemented yet.</div>'+
          create+card('Stock Movement History',tbody(['Document','SKU','Movement','Quantity','Unit Cost (PKR)','Job'],rows));
      }
      case 'auto:service-invoices':{
        const rows=invoices.map(i=>'<tr>'+col(i.reference)+col(i.job_reference)+col(i.customer_name)+col(i.due_date)+amount(i.labor_amount_paisa)+amount(i.paid_paisa)+amount(i.balance_paisa)+'<td>'+
          (BigInt(i.balance_paisa)>0n&&roleCan(['ADMIN','FINANCE'],role)?action('Receive Payment','pay-invoice',i.id):'—')+'</td></tr>');
        const completed=jobs.filter(x=>x.status==='COMPLETED'&&!invoices.some(i=>i.job_reference===x.reference));
        const create=roleCan(['ADMIN','FINANCE'],role)?form('service-invoice',[
          pick('Completed Job Card','jobId',options(completed,'id',x=>x.reference+' / '+x.customer_name,'Select completed, uninvoiced job')),
          field('Labor Charges (PKR)','laborAmount','0.00'),
          field('Invoice Date','date','','date',true,today()),
          field('Due Date','dueDate','','date',true,today())
        ],'Issue Service Labor Invoice'):'';
        return '<div class="banner"><strong>Accounting-connected invoices</strong> Invoice posts Accounts Receivable Dr / Service Revenue Cr. Payment posts Bank Dr / Accounts Receivable Cr. For this slice invoices contain labor only—no tax or parts billing yet.</div>'+
          create+card('Service Invoices & Payments',tbody(['Invoice','Job','Customer','Due','Total (PKR)','Paid','Outstanding','Action'],rows));
      }
      case 'auto:ar-aging':{
        const invoices=state['reports/ar-aging']||[];
        const rows=invoices.map(i=>{
          const days=Number(i.days_overdue);
          const bucket=days===0?'CURRENT':days<=30?'1–30':days<=60?'31–60':days<=90?'61–90':'90+';
          return '<tr>'+col(i.reference)+col(i.customer_name)+col(i.due_date)+col(days)+col(bucket)+amount(i.outstanding_paisa)+'</tr>';
        });
        const total=invoices.reduce((v,i)=>v+BigInt(i.outstanding_paisa),0n);
        return card('Outstanding Service Receivables',
          '<div class="card-body"><p class="muted small">Current balances only; overdue days calculated from the database current date. Paid invoices excluded.</p><h2>Outstanding PKR '+format(total)+'</h2></div>'+
          tbody(['Invoice','Customer','Due Date','Days Overdue','Aging Band','Open Balance (PKR)'],rows));
      }
      default:return '<div class="banner">Unknown dealership page</div>';
    }
  }
  async function submit(event,{post,open,notify}){
    event.preventDefault();
    const f=event.target,fd=new FormData(f),data=Object.fromEntries(fd.entries());
    const modes={
      customer:{url:'/api/auto/customers',payload:()=>({name:data.name,phone:data.phone,email:data.email})},
      'customer-vehicle':{url:'/api/auto/customer-vehicles',payload:()=>({customerId:data.customerId,registration:data.registration,chassis:data.chassis,model:data.model})},
      'vehicle-stock':{url:'/api/auto/vehicle-stock',payload:()=>({chassis:data.chassis,variant:data.variant,color:data.color,price:data.price})},
      'sales-booking':{url:'/api/auto/sales/bookings',payload:()=>({customerId:data.customerId,vehicleId:data.vehicleId,price:data.price})},
      'service-job':{url:'/api/auto/service/jobs',payload:()=>({vehicleId:data.vehicleId,complaint:data.complaint})},
      part:{url:'/api/auto/parts',payload:()=>({sku:data.sku,name:data.name})},
      'stock-movement':{url:'/api/auto/stock-movements',payload:()=>({partId:data.partId,direction:data.direction,quantity:Number(data.quantity),reference:data.reference,unitCost:data.unitCost,jobId:data.jobId})},
      'service-invoice':{url:'/api/auto/service/invoices',payload:()=>({jobId:data.jobId,laborAmount:data.laborAmount,date:data.date,dueDate:data.dueDate})}
    };
    const mode=modes[f.dataset.mode];
    if(!mode)return;
    const submit=f.querySelector('button[type=submit]');submit.disabled=true;
    try{
      await post(mode.url,mode.payload());
      await open(state.page);notify('Saved successfully');
    }catch(e){notify(e.message,true);}
    finally{submit.disabled=false;}
  }
  async function act(verb,id,{post,open,notify}){
    try{
      if(verb==='cancel-booking'){
        if(!confirm('Cancel this booking and release the reserved vehicle?'))return;
        await post('/api/auto/sales/bookings/'+id+'/cancel',{});
      }else if(verb==='status-IN_PROGRESS'||verb==='status-COMPLETED'){
        const status=verb.slice('status-'.length);
        if(!confirm('Update job status to '+status+'?'))return;
        await post('/api/auto/service/jobs/'+id+'/status',{status});
      }else if(verb==='pay-invoice'){
        const amount=prompt('Payment received (PKR), e.g. 5000.00');if(amount===null)return;
        if(!amount.trim())throw Error('Payment amount required');
        const date=prompt('Receipt date (YYYY-MM-DD)',today());if(date===null)return;
        await post('/api/auto/service/invoices/'+id+'/payments',{amount,date});
      }else{return;}
      await open(state.page);notify('Transaction recorded');
    }catch(e){notify(e.message,true);}
  }
  window.AQVORA_AUTO={load,render,submit,act};
})();

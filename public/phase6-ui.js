/* AQVORA Plus Phase 6: four-eyes vehicle price-refund requests and audit. */
(function(){
  'use strict';
  const state={};
  const e=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cash=x=>{const n=BigInt(x||0),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n).toLocaleString('en-PK')+'.'+String(a%100n).padStart(2,'0');};
  const td=x=>'<td>'+e(x)+'</td>',amt=x=>'<td class="amount">PKR '+cash(x)+'</td>';
  const table=(cols,records)=>'<div class="table-wrap"><table><thead><tr>'+cols.map(h=>'<th>'+e(h)+'</th>').join('')+'</tr></thead><tbody>'+
    (records.length?records.join(''):'<tr><td class="empty" colspan="'+cols.length+'">No records</td></tr>')+'</tbody></table></div>';
  const card=(heading,contents)=>'<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>'+e(heading)+'</h2></div>'+contents+'</div>';
  const input=(label,name,type='text',required=true,value='')=>'<div class="field"><label>'+e(label)+'</label><input name="'+e(name)+'" type="'+type+'" value="'+e(value)+'" '+(required?'required':'')+'/></div>';
  const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
  const button=(label,verb,id)=>'<button type="button" class="secondary" data-action="phase6:'+e(verb)+'" data-id="'+e(id)+'">'+e(label)+'</button>';
  async function load(page,api){
    const paths=page==='phase6:queue'?[
      ['/api/phase6/refunds','requests'],
      ['/api/finance4/sales-invoices','invoices'],
      ['/api/phase6/refunds/audit','audit']
    ]:[['/api/phase6/refunds/audit','audit'],['/api/phase6/refunds','requests']];
    for(const [path,key] of paths)state[key]=await api(path);
    state.page=page;
  }
  function render(page,role){
    const approvals=state.requests?.requests||[],audit=state.audit||{};
    const metrics='<div class="stat-grid">'+[
      ['Awaiting Approval',audit.pending||0],['Approved, Not Paid',audit.approved||0],
      ['Executed Refunds',audit.executed||0],['Bank Refunds', 'PKR '+cash(audit.paid_out_paisa)]
    ].map(([label,value])=>'<div class="card stat"><span class="stat-kicker">'+e(label)+'</span><strong class="stat-value">'+e(value)+'</strong></div>').join('')+'</div>';
    if(page==='phase6:audit'){
      return '<div class="banner"><strong>Refund source audit</strong>Tracks approvals, immutable cash-out vouchers and credit-note links. This does not replace bank statement reconciliation or external audit.</div>'+
        metrics+card('Audit Integrity',
          table(['Control','Result'],[
            '<tr>'+td('Approval workflow')+td((audit.pending||0)+' pending / '+(audit.rejected||0)+' rejected')+'</tr>',
            '<tr>'+td('Refund vouchers not posted')+td(audit.unposted_refund_vouchers||0)+'</tr>',
            '<tr>'+td('Broken source links')+td(audit.broken_links||0)+'</tr>',
            '<tr>'+td('Refund controls')+td(audit.reconciled?'MATCH':'REVIEW REQUIRED')+'</tr>'
          ]))+
        card('Recent Refund Requests',listRequests(approvals,role,false));
    }
    const invoices=(state.invoices?.invoices||[]).filter(i=>BigInt(i.paid_paisa||0)>0n&&
      BigInt(i.sales_amount_paisa||0)>BigInt(i.credited_net_paisa||0));
    const form=role==='FINANCE'?'<form id="phase6-form" class="card" style="margin-bottom:18px">'+
      '<div class="card-head"><h2>Request Customer Refund</h2></div>'+
      '<div class="card-body"><div class="form-grid"><div class="field"><label>Paid vehicle invoice</label>'+
      '<select name="invoiceId" required><option value="">Choose an invoice</option>'+
      invoices.map(i=>'<option value="'+e(i.id)+'">'+e(i.reference+' — '+i.customer_name)+' / Paid PKR '+cash(i.paid_paisa)+'</option>').join('')+
      '</select></div>'+
      input('Net price adjustment (PKR)','netAmount')+
      input('Refund date','date','date',true,today())+
      input('Detailed reason (min 8 characters)','reason')+
      '</div></div>'+
      '<div class="form-footer"><span class="muted small">No money moves until an independent Admin approves and Finance executes the request.</span>'+
      '<button class="primary" type="submit">Submit for Approval</button></div></form>':'';
    return '<div class="banner"><strong>Dual-control refund workflow</strong>Finance submits, a different Admin approves, and Finance executes the cash refund together with a linked credit note. Full vehicle returns, supplier refunds and cash payouts without authorization are not supported.</div>'+
      metrics+form+card('Refund Approval Queue',listRequests(approvals,role,true));
  }
  function listRequests(requests,role,actions){
    return table(['Invoice','Customer','Net Credit','Sales Tax','Refund / Bank Out','Status','Requested By','Reviewed By','Action'],
      requests.map(x=>{
        let action='—';
        if(actions&&role==='ADMIN'&&x.status==='PENDING'){
          action=button('Approve','approve',x.id)+' '+button('Reject','reject',x.id);
        }else if(actions&&role==='FINANCE'&&x.status==='APPROVED'){
          action=button('Post Refund','execute',x.id);
        }
        return '<tr>'+td(x.invoice_reference)+td(x.customer_name)+amt(x.credit_net_paisa)+amt(x.credit_tax_paisa)+amt(x.refund_amount_paisa)+
          td(x.status)+td(x.requested_by_email)+td(x.approved_by_email||'—')+'<td>'+action+'</td></tr>';
      }));
  }
  async function submit(event,{post,open,notify}){
    event.preventDefault();
    const form=event.target,button=form.querySelector('button[type=submit]');
    const fields=Object.fromEntries(new FormData(form).entries());
    fields.clientKey=crypto.randomUUID();
    button.disabled=true;
    try{
      const r=await post('/api/phase6/refunds/requests',fields);
      await open(state.page);
      notify('Refund request submitted: '+r.id);
    }catch(err){notify(err.message,true);}
    finally{button.disabled=false;}
  }
  async function act(verb,id,{post,open,notify}){
    try{
      if(verb==='approve'||verb==='reject'){
        const decision=verb==='approve'?'APPROVED':'REJECTED';
        if(!confirm(decision+' refund request? This decision is auditable and cannot be changed.'))return;
        await post('/api/phase6/refunds/'+id+'/decision',{decision});
      }else if(verb==='execute'){
        if(!confirm('POST the approved refund to Bank and issue its linked credit note? This cannot be undone in this prototype.'))return;
        await post('/api/phase6/refunds/'+id+'/execute',{});
      }else return;
      await open(state.page);
      notify('Refund workflow updated');
    }catch(err){notify(err.message,true);}
  }
  window.AQVORA_PHASE6={load,render,submit,act};
})();
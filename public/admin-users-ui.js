/* AQVORA Plus: minimal Admin-only staff provisioning (development). */
(function(){
'use strict';
const safe=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const state={users:[]};
async function load(page,api){
 const data=await api('/api/admin/users');
 state.users=data.users||[];
}
function render(page,role){
 if(role!=='ADMIN')return '<div class="banner">Admin-only access.</div>';
 const rows=state.users.map(x=>
   '<tr><td>'+safe(x.email)+'</td><td>'+safe(x.role)+'</td><td>'+(x.must_change_password?'Temporary password — pending change':'Password initialized')+'</td><td>'+(x.active?'Active':'Disabled')+'</td></tr>'
 );
 const list='<div class="table-wrap"><table><thead><tr><th>Email</th><th>Company Role</th><th>First-Login Status</th><th>Account</th></tr></thead><tbody>'+
   (rows.length?rows.join(''):'<tr><td colspan="4">No staff accounts</td></tr>')+'</tbody></table></div>';
 const roles=['FINANCE','SALES','SERVICE','PARTS','VIEWER'];
 const options=roles.map(r=>'<option value="'+r+'">'+r+'</option>').join('');
 const form='<form id="staff-provision-form" class="card" autocomplete="off">'+
   '<div class="card-head"><h2>Create Staff Login</h2></div>'+
   '<div class="card-body"><div class="form-grid">'+
     '<div class="field"><label for="staff-email">Staff email</label><input id="staff-email" name="email" type="email" required maxlength="254" autocomplete="off"></div>'+
     '<div class="field"><label for="staff-role">Role</label><select id="staff-role" name="role">'+options+'</select></div>'+
     '<div class="field wide"><label for="staff-temp-pass">Temporary password (14+ characters)</label>'+
     '<input id="staff-temp-pass" name="temporaryPassword" type="password" required minlength="14" maxlength="256" autocomplete="new-password"></div>'+
   '</div></div>'+
   '<div class="form-footer"><span class="muted small">One-time initial password only. Share it securely. Staff must replace it before using accounting or operations.</span>'+
   '<button type="submit" class="primary">Create Staff User</button></div></form>';
 return '<div class="banner"><strong>Company Staff & Permissions</strong>Admin can create non-Admin staff for this company only. An existing user email cannot be attached automatically to another company. Invitations, MFA and staff disablement are not implemented.</div>'+
   '<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>Authorized Staff</h2></div>'+list+'</div>'+form;
}
async function submit(event,{post,open,notify}){
 event.preventDefault();
 const form=event.target,b=form.querySelector('button[type=submit]');
 const d=Object.fromEntries(new FormData(form).entries());
 if(String(d.temporaryPassword).length<14){notify('Temporary password must be at least 14 characters',true);return;}
 b.disabled=true;
 try{
   const user=await post('/api/admin/users',d);
   form.reset();
   await open('admin:users');
   notify('Staff user '+user.email+' created. First-login password change required.');
 }catch(e){notify(e.message,true);}finally{b.disabled=false;}
}
window.AQVORA_USERS={load,render,submit};
})();
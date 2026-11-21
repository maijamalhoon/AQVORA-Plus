import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp,hashPassword} from '../server/api.mjs';

test('Admin provisions only new non-Admin staff; first-login rotation gates all business APIs and revokes sessions',{
  skip:!process.env.DATABASE_URL
},async t=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const tag=randomBytes(6).toString('hex');
 const company=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',
   ['A'+tag,'Staff Onboarding QA'])).rows[0].id;
 const other=(await pool.query('INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',
   ['B'+tag,'Different Tenant QA'])).rows[0].id;
 const adminEmail='admin-'+tag+'@example.test';
 const adminPass='Bootstrap-Admin-Initial-Password-2026!';
 const admin=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
  [adminEmail,hashPassword(adminPass)])).rows[0].id;
 await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',
   [company,admin,'ADMIN']);
 const existingEmail='existing-'+tag+'@example.test';
 const existing=(await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
   [existingEmail,hashPassword(adminPass)])).rows[0].id;
 await pool.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',
   [other,existing,'FINANCE']);
 const app=createApp(pool);
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.close(resolve));await pool.end();});
 const base='http://127.0.0.1:'+app.address().port;
 async function request(path,{method='GET',body,cookie,tenant=company}={}){
  const headers={accept:'application/json'};
  if(method==='POST')headers['X-AQVORA-Request']='1';
  if(body!==undefined)headers['Content-Type']='application/json';
  if(cookie)headers.Cookie=cookie;
  if(tenant)headers['X-Company-ID']=tenant;
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 const login=async(email,password)=>request('/api/auth/login',{method:'POST',tenant:null,body:{email,password}});
 const adminLogin=await login(adminEmail,adminPass);
 assert.equal(adminLogin.status,200);
 const ownerCookie=adminLogin.cookie;
 const adminRequest=(path,opts={})=>request(path,{cookie:ownerCookie,...opts});
 const initial=await adminRequest('/api/admin/users');
 assert.equal(initial.status,200);
 assert.equal(initial.data.users.length,1);
 const staffEmail='finance-'+tag+'@example.test',temp='Temporary-Finance-Password-2026',next='Private-Rotated-Password-2026!';
 const invite={email:staffEmail,role:'FINANCE',temporaryPassword:temp};
 assert.equal((await request('/api/admin/users',{method:'POST',body:invite})).status,401,'Authentication required');
 assert.equal((await adminRequest('/api/admin/users',{method:'POST',body:{...invite,role:'ADMIN'}})).status,400,
   'Provisioning cannot create privileged Admin accounts');
 assert.equal((await adminRequest('/api/admin/users',{method:'POST',body:{...invite,temporaryPassword:'short'}})).status,400);
 assert.equal((await adminRequest('/api/admin/users',{method:'POST',body:{...invite,email:existingEmail}})).status,409,
   'Existing identities from another tenant cannot be silently shared');
 const created=await adminRequest('/api/admin/users',{method:'POST',body:invite});
 assert.equal(created.status,201,JSON.stringify(created.data));
 assert.equal(created.data.role,'FINANCE');
 assert.equal(created.data.must_change_password,true);
 assert.equal((await adminRequest('/api/admin/users',{method:'POST',body:invite})).status,409);
 const users=(await adminRequest('/api/admin/users')).data.users;
 const staff=users.find(x=>x.email===staffEmail);
 assert.equal(staff.role,'FINANCE');assert.equal(staff.must_change_password,true);
 assert.equal(users.some(x=>x.email===existingEmail),false,'Cannot see another company user');

 const staffLogin=await login(staffEmail,temp);
 assert.equal(staffLogin.status,200,JSON.stringify(staffLogin.data));
 const staffCookie=staffLogin.cookie;
 const asStaff=(path,opts={})=>request(path,{cookie:staffCookie,...opts});
 const me=await asStaff('/api/auth/me');
 assert.equal(me.status,200);assert.equal(me.data.user.must_change_password,true);
 assert.equal((await asStaff('/api/reports/trial-balance')).status,403,'Staff cannot skip password rotation');
 assert.equal((await asStaff('/api/finance4/suppliers')).status,403);
 assert.equal((await asStaff('/api/admin/users')).status,403);
 const wrong=await asStaff('/api/auth/change-password',{method:'POST',body:{
   currentPassword:'Not-Current-Password',newPassword:next
 }});
 assert.equal(wrong.status,403);
 const same=await asStaff('/api/auth/change-password',{method:'POST',body:{
   currentPassword:temp,newPassword:temp
 }});
 assert.equal(same.status,400);
 const changed=await asStaff('/api/auth/change-password',{method:'POST',body:{
   currentPassword:temp,newPassword:next
 }});
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.reauthenticate,true);
 assert.equal((await asStaff('/api/auth/me')).status,401,'Password change revokes current and other sessions');
 assert.equal((await login(staffEmail,temp)).status,401,'Admin-issued initial password cannot be reused');
 const after=await login(staffEmail,next);
 assert.equal(after.status,200,'New private staff password works');
 const newCookie=after.cookie;
 const staffMe=await request('/api/auth/me',{cookie:newCookie});
 assert.equal(staffMe.data.user.must_change_password,false);
 assert.equal((await request('/api/reports/trial-balance',{cookie:newCookie})).status,200,
   'Business APIs are enabled after staff rotates the temporary password');
 assert.equal((await request('/api/admin/users',{cookie:newCookie})).status,403,
   'Finance cannot provision more staff');
 assert.equal((await request('/api/reports/trial-balance',{cookie:newCookie,tenant:other})).status,403,
   'Finance cannot switch into an unassigned tenant');
 const audit=await pool.query("SELECT action FROM audit_events WHERE company_id=$1 AND action IN ('STAFF_USER_CREATED','PASSWORD_CHANGED')",[company]);
 assert.equal(audit.rowCount,2);
});

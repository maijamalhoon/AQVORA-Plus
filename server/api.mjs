import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import {permitted,validateDraft,periodOf,voucherNumber,validDate} from './logic.mjs';
import {handleAutomotiveApi} from './automotive.mjs';
import {handlePhase4Api} from './finance-operations.mjs';
import {handlePhase5Api} from './phase5.mjs';

const {Pool}=pg, publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const uuid=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const attempts=new Map();
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new HttpError(status,message);};
const hashToken=x=>createHash('sha256').update(x).digest('hex');
export function hashPassword(password,salt=randomBytes(16).toString('hex')){
  if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Password length must be 12–256');
  return 'scrypt$'+salt+'$'+scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
}
export function verifyPassword(password,stored){
  try {
    const [scheme,salt,key]=String(stored).split('$');
    if(scheme!=='scrypt'||!/^[a-f0-9]{32}$/.test(salt)||!/^[a-f0-9]{128}$/.test(key)||typeof password!=='string'||password.length>256)return false;
    return timingSafeEqual(scryptSync(password,Buffer.from(salt,'hex'),64),Buffer.from(key,'hex'));
  }catch{return false;}
}
function send(res,status,value,headers={}){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(value));
}
function secureHeaders(res){
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('content-security-policy',"default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}
function cookie(req,key){
  return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='))?.slice(key.length+1)||null;
}
function sessionCookie(res,value,secure,maxAge=28800){
  res.setHeader('set-cookie','aqvora_session='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(secure?'; Secure':''));
}
function guardMutation(req){
  if(req.method==='GET'||req.method==='HEAD')return;
  if(req.headers['x-aqvora-request']!=='1')fail(403,'Missing request verification header');
  if(req.headers.origin){
    try{
      const origin=new URL(req.headers.origin);
      if(origin.host!==req.headers.host||!['http:','https:'].includes(origin.protocol))fail(403,'Cross-origin request blocked');
    }catch{fail(403,'Invalid origin');}
  }
}
async function readJson(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'JSON body required');
  let length=0;const chunks=[];
  for await(const part of req){length+=part.length;if(length>64000)fail(413,'Request too large');chunks.push(part);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{fail(400,'Invalid JSON');}
}
async function tx(pool,handler){
  const db=await pool.connect();
  try{await db.query('BEGIN');const result=await handler(db);await db.query('COMMIT');return result;}
  catch(e){await db.query('ROLLBACK');throw e;}
  finally{db.release();}
}
async function identity(pool,req){
  const session=cookie(req,'aqvora_session');
  if(!session||!/^[a-f0-9]{64}$/.test(session))fail(401,'Please sign in');
  const r=await pool.query('SELECT u.id,u.email FROM sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hashToken(session)]);
  if(!r.rowCount)fail(401,'Session expired');
  const user=r.rows[0];
  const m=await pool.query('SELECT m.company_id,m.role,m.department_id,c.code AS company_code,c.name AS company_name FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=$1 ORDER BY c.name',[user.id]);
  const chosen=req.headers['x-company-id'];
  if(chosen&&(typeof chosen!=='string'||!uuid.test(chosen)))fail(400,'Invalid company');
  const selected=chosen?m.rows.find(x=>x.company_id===chosen):m.rows[0];
  if(!selected)fail(403,'No company membership');
  return {user,selected,memberships:m.rows};
}
const permission=(ctx,action)=>{if(!permitted(ctx.selected.role,action))fail(403,'Not authorized for this operation');};
async function openPeriod(db,company,date){
  const r=await db.query('SELECT status FROM fiscal_periods WHERE company_id=$1 AND period=$2 FOR UPDATE',[company,periodOf(date)]);
  if(!r.rowCount||r.rows[0].status!=='OPEN')fail(409,'Fiscal period is missing or locked');
}
async function nextNumber(db,company,type,date){
  const r=await db.query('INSERT INTO voucher_sequences(company_id,voucher_type,period,last_number) VALUES($1,$2,$3,1) ON CONFLICT(company_id,voucher_type,period) DO UPDATE SET last_number=voucher_sequences.last_number+1 RETURNING last_number',[company,type,periodOf(date)]);
  return voucherNumber(type,date,r.rows[0].last_number);
}
async function postExisting(db,ctx,v){
  if(v.status!=='DRAFT')fail(409,'Already posted');
  const company=ctx.selected.company_id;
  await openPeriod(db,company,v.voucher_date);
  const number=await nextNumber(db,company,v.voucher_type,v.voucher_date);
  await db.query('UPDATE vouchers SET status=$1,voucher_number=$2,posted_by=$3,posted_at=now() WHERE company_id=$4 AND id=$5',['POSTED',number,ctx.user.id,company,v.id]);
  await db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',[company,ctx.user.id,'VOUCHER_POSTED',v.id,JSON.stringify({number})]);
  return number;
}
async function route(req,res,pool,production){
  const uri=new URL(req.url||'/','http://localhost'),path=uri.pathname;
  if(path==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,app:'AQVORA Plus'});
  if(!path.startsWith('/api/')){
    const allowed={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/automotive-ui.js':'automotive-ui.js','/finance-ui.js':'finance-ui.js','/phase5-ui.js':'phase5-ui.js'};
    if(!allowed[path]||req.method!=='GET')return send(res,404,{error:'Not found'});
    const filename=allowed[path],content=await readFile(join(publicDir,filename));
    res.writeHead(200,{'content-type':filename.endsWith('.css')?'text/css; charset=utf-8':filename.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});
    return res.end(content);
  }
  guardMutation(req);
  if(path==='/api/auth/login'&&req.method==='POST'){
    const ip=req.socket.remoteAddress||'unknown',now=Date.now();
    let state=attempts.get(ip)||{count:0,expires:now+600000};
    if(now>state.expires)state={count:0,expires:now+600000};
    if(state.count>=10)fail(429,'Too many login attempts');
    const data=await readJson(req),email=typeof data.email==='string'?data.email.trim().toLowerCase():'',password=data.password;
    if(email.length>254||typeof password!=='string'||password.length>256)fail(400,'Invalid credentials');
    const result=await pool.query('SELECT id,password_hash FROM app_users WHERE email=$1 AND active=true',[email]);
    if(!result.rowCount||!verifyPassword(password,result.rows[0].password_hash)){
      state.count++;attempts.set(ip,state);fail(401,'Incorrect email or password');
    }
    attempts.delete(ip);
    const token=randomBytes(32).toString('hex');
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",[hashToken(token),result.rows[0].id]);
    sessionCookie(res,token,production);return send(res,200,{ok:true});
  }
  if(path==='/api/auth/logout'&&req.method==='POST'){
    const token=cookie(req,'aqvora_session');
    if(token&&/^[a-f0-9]{64}$/.test(token))await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(token)]);
    sessionCookie(res,'',production,0);return send(res,200,{ok:true});
  }
  const ctx=await identity(pool,req),company=ctx.selected.company_id;
  if(await handlePhase5Api({req,res,pool,ctx,uri,path,send,fail,readJson,tx,postExisting,openPeriod}))return;
  if(await handlePhase4Api({req,res,pool,ctx,uri,path,send,fail,readJson,tx,postExisting,openPeriod}))return;
  if(await handleAutomotiveApi({req,res,pool,ctx,uri,path,send,fail,readJson,tx,postExisting,openPeriod}))return;
  if(path==='/api/auth/me'&&req.method==='GET')return send(res,200,{user:ctx.user,memberships:ctx.memberships,selected:ctx.selected});
  if(path==='/api/accounts'&&req.method==='GET'){
    permission(ctx,'vouchers:read');
    const r=await pool.query('SELECT code,name,kind FROM accounts WHERE company_id=$1 AND active=true ORDER BY code',[company]);
    return send(res,200,{accounts:r.rows});
  }
  if(path==='/api/departments'&&req.method==='GET'){
    permission(ctx,'vouchers:read');
    const r=await pool.query('SELECT code,name FROM departments WHERE company_id=$1 ORDER BY name',[company]);
    return send(res,200,{departments:r.rows});
  }
  if(path==='/api/vouchers'&&req.method==='GET'){
    permission(ctx,'vouchers:read');
    const r=await pool.query('SELECT v.id,v.voucher_type AS type,v.voucher_date::text AS date,v.voucher_number AS number,v.narrative,v.status,d.code AS department,v.created_at FROM vouchers v JOIN departments d ON d.id=v.department_id AND d.company_id=v.company_id WHERE v.company_id=$1 ORDER BY v.created_at DESC LIMIT 100',[company]);
    return send(res,200,{vouchers:r.rows});
  }
  if(path==='/api/vouchers'&&req.method==='POST'){
    permission(ctx,'vouchers:create');const data=validateDraft(await readJson(req));
    const id=await tx(pool,async db=>{
      const dept=await db.query('SELECT id FROM departments WHERE company_id=$1 AND code=$2',[company,data.department]);
      if(!dept.rowCount)fail(400,'Unknown department');
      const codes=[...new Set(data.lines.map(l=>l.code))];
      const a=await db.query('SELECT id,code FROM accounts WHERE company_id=$1 AND active=true AND code=ANY($2::text[])',[company,codes]);
      if(a.rowCount!==codes.length)fail(400,'Unknown or inactive account');
      const codesToIds=new Map(a.rows.map(x=>[x.code,x.id]));
      const voucher=await db.query('INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[company,dept.rows[0].id,data.type,data.date,data.narrative,ctx.user.id]);
      const voucherId=voucher.rows[0].id;
      for(const [i,l] of data.lines.entries())
        await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) VALUES($1,$2,$3,$4,$5,$6)',[company,voucherId,codesToIds.get(l.code),i+1,l.debit,l.credit]);
      await db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',[company,ctx.user.id,'VOUCHER_CREATED',voucherId]);
      return voucherId;
    });
    return send(res,201,{id,status:'DRAFT'});
  }
  const post=/^\/api\/vouchers\/([\da-f-]{36})\/post$/.exec(path);
  if(post&&req.method==='POST'){
    permission(ctx,'vouchers:post');if(!uuid.test(post[1]))fail(400,'Invalid voucher ID');
    const number=await tx(pool,async db=>{
      const r=await db.query('SELECT id,voucher_type,voucher_date::text,status FROM vouchers WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,post[1]]);
      if(!r.rowCount)fail(404,'Voucher not found');
      return postExisting(db,ctx,r.rows[0]);
    });
    return send(res,200,{status:'POSTED',number});
  }
  const reverse=/^\/api\/vouchers\/([\da-f-]{36})\/reverse$/.exec(path);
  if(reverse&&req.method==='POST'){
    permission(ctx,'vouchers:reverse');if(!uuid.test(reverse[1]))fail(400,'Invalid voucher ID');
    const data=await readJson(req);
    if(!validDate(data?.date)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>2000)fail(400,'Valid date and reason required');
    const posted=await tx(pool,async db=>{
      const r=await db.query('SELECT id,department_id,voucher_type,voucher_date::text,status FROM vouchers WHERE company_id=$1 AND id=$2 FOR UPDATE',[company,reverse[1]]);
      if(!r.rowCount)fail(404,'Voucher not found');
      const original=r.rows[0];
      if(original.status!=='POSTED'||original.voucher_type==='REV')fail(409,'Only original posted vouchers may be reversed');
      const links=await db.query(
        "SELECT (EXISTS(SELECT 1 FROM service_invoices WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM service_invoice_payments WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM purchase_bills WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM supplier_payments WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM vehicle_sales_invoices WHERE company_id=$1 AND (revenue_voucher_id=$2 OR cogs_voucher_id=$2 OR tax_voucher_id=$2))"+
        " OR EXISTS(SELECT 1 FROM vehicle_credit_notes WHERE company_id=$1 AND (revenue_voucher_id=$2 OR tax_voucher_id=$2))"+
        " OR EXISTS(SELECT 1 FROM purchase_returns WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM vehicle_sales_payments WHERE company_id=$1 AND voucher_id=$2)"+
        " OR EXISTS(SELECT 1 FROM stock_movements WHERE company_id=$1 AND accounting_voucher_id=$2)) AS linked",
        [company,original.id]);
      if(links.rows[0].linked)fail(409,'Source-linked invoices/payments require a dedicated credit-note workflow');
      await openPeriod(db,company,data.date);
      const reversal=await db.query("INSERT INTO vouchers(company_id,department_id,voucher_type,voucher_date,narrative,created_by,reverses_id) VALUES($1,$2,'REV',$3,$4,$5,$6) RETURNING id,voucher_type,voucher_date::text,status",[company,original.department_id,data.date,data.reason.trim(),ctx.user.id,original.id]);
      const v=reversal.rows[0];
      await db.query('INSERT INTO voucher_lines(company_id,voucher_id,account_id,line_number,debit_paisa,credit_paisa) SELECT company_id,$1,account_id,line_number,credit_paisa,debit_paisa FROM voucher_lines WHERE company_id=$2 AND voucher_id=$3',[v.id,company,original.id]);
      const number=await postExisting(db,ctx,v);
      await db.query('INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',[company,ctx.user.id,'VOUCHER_REVERSED',v.id,JSON.stringify({reverses:original.id})]);
      return {id:v.id,number};
    });
    return send(res,201,{...posted,status:'POSTED'});
  }
  const detail=/^\/api\/vouchers\/([\da-f-]{36})$/.exec(path);
  if(detail&&req.method==='GET'){
    permission(ctx,'vouchers:read');if(!uuid.test(detail[1]))fail(400,'Invalid voucher ID');
    const h=await pool.query('SELECT id,voucher_type,voucher_date::text AS date,voucher_number,narrative,status,reverses_id FROM vouchers WHERE company_id=$1 AND id=$2',[company,detail[1]]);
    if(!h.rowCount)fail(404,'Voucher not found');
    const lines=await pool.query('SELECT l.line_number,a.code,a.name,l.debit_paisa::text,l.credit_paisa::text FROM voucher_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id WHERE l.company_id=$1 AND l.voucher_id=$2 ORDER BY l.line_number',[company,detail[1]]);
    return send(res,200,{voucher:h.rows[0],lines:lines.rows});
  }
  if(path==='/api/reports/trial-balance'&&req.method==='GET'){
    permission(ctx,'reports:read');
    const r=await pool.query("SELECT a.code,a.name,a.kind,coalesce(sum(CASE WHEN v.id IS NOT NULL THEN l.debit_paisa-l.credit_paisa ELSE 0 END),0)::text AS balance_paisa FROM accounts a LEFT JOIN voucher_lines l ON l.account_id=a.id AND l.company_id=a.company_id LEFT JOIN vouchers v ON v.id=l.voucher_id AND v.company_id=a.company_id AND v.status='POSTED' WHERE a.company_id=$1 GROUP BY a.id,a.code,a.name,a.kind ORDER BY a.code",[company]);
    return send(res,200,{rows:r.rows});
  }
  if(path==='/api/reports/ledger'&&req.method==='GET'){
    permission(ctx,'reports:read');
    const code=uri.searchParams.get('account')||'';
    if(!code||code.length>50)fail(400,'Account required');
    const r=await pool.query("SELECT v.voucher_number,v.voucher_date::text AS voucher_date,v.narrative,l.debit_paisa::text,l.credit_paisa::text FROM vouchers v JOIN voucher_lines l ON l.voucher_id=v.id AND l.company_id=v.company_id JOIN accounts a ON a.id=l.account_id AND a.company_id=v.company_id WHERE v.company_id=$1 AND v.status='POSTED' AND a.code=$2 ORDER BY v.voucher_date,v.posted_at,v.id,l.line_number LIMIT 2000",[company,code]);
    return send(res,200,{rows:r.rows});
  }
  if(path==='/api/audit'&&req.method==='GET'){
    permission(ctx,'reports:read');
    const r=await pool.query('SELECT action,entity_id,occurred_at FROM audit_events WHERE company_id=$1 ORDER BY occurred_at DESC LIMIT 100',[company]);
    return send(res,200,{events:r.rows});
  }
  return send(res,404,{error:'Not found'});
}
export function createApp(pool,{production=false}={}){
  return createServer(async (req,res)=>{
    secureHeaders(res);
    try{await route(req,res,pool,production);}
    catch(error){
      const status=error instanceof HttpError?error.status:error?.code==='23505'?409:['23503','23514','22P02','22003'].includes(error?.code)?400:500;
      if(status===500)console.error('AQVORA Plus server failure',error);
      send(res,status,{error:error instanceof HttpError?error.message:status===409?'Conflicting record':status===400?'Invalid data':'Internal server error'});
    }
  });
}
export function poolFromEnv(){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL must point to a dedicated AQVORA Plus database');
  return new Pool({connectionString:process.env.DATABASE_URL,max:10});
}

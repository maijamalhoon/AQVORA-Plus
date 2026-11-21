// AQVORA Plus Vercel-compatible Express entrypoint.
// No backend credentials are sent to clients. All authenticated finance,
// dealership and BRS routes reuse the same tested Node HTTP request handler.
import express from 'express';
import {fileURLToPath} from 'node:url';
import {createRequestHandler,poolFromEnv} from './server/api.mjs';

const app=express();
app.disable('x-powered-by');
app.disable('etag');
const publicDir=fileURLToPath(new URL('./public/',import.meta.url));
const handlerPool=process.env.DATABASE_URL?poolFromEnv():null;
const handle=handlerPool?createRequestHandler(handlerPool,{production:process.env.NODE_ENV==='production'||Boolean(process.env.VERCEL)}):null;

// Public health endpoint is strictly informational. A rendered UI is not
// equivalent to a working finance application until the schema is connected.
app.get('/api/demo-status',async(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!handlerPool)return res.status(200).json({
    online:true,database:'not-configured',workingDemo:false,
    message:'Connect a NEW isolated demo PostgreSQL database and apply migrations 001–009.'
  });
  try{
    const q=await handlerPool.query(
      "SELECT count(*)::int AS applied FROM schema_migrations WHERE name IN ('001_initial.sql','002_automotive.sql','003_accounted_finance.sql','004_tax_returns_delivery.sql','005_refund_approvals.sql','006_supplier_refunds.sql','007_audit_immutability.sql','008_staff_first_login.sql','009_bank_reconciliation.sql')"
    );
    const applied=q.rows[0]?.applied||0;
    return res.status(200).json({
      online:true,database:applied===9?'ready':'needs-migrations',
      migrationsApplied:applied,expectedMigrations:9,workingDemo:applied===9,
      message:applied===9?'Demo database schema is ready. Log in using a demo Admin account.':'Run AQVORA Plus migrations on the dedicated demo database.'
    });
  }catch(error){
    console.error('AQVORA Plus demo database check failed',error?.code||error?.name||'ERROR');
    return res.status(200).json({
      online:true,database:'unavailable',workingDemo:false,
      message:'Demo PostgreSQL connection or schema unavailable. Check private Vercel environment configuration.'
    });
  }
});

// Static UI and JS belong to the preview itself, not a separate origin.
app.use(express.static(publicDir,{
  index:'index.html',redirect:false,fallthrough:true,
  setHeaders(res){res.setHeader('Cache-Control','no-store');}
}));

app.use((req,res)=>{
  if(!handlerPool){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({
      error:'Demo database not configured',
      setup:'A separate AQVORA Plus PostgreSQL connection is required. Never connect to a business production database.'
    });
  }
  // The native handler handles authentication, permissions, transactions,
  // vouchers, automotive workflows, BRS and source-linked accounting.
  return handle(req,res);
});

export default app;

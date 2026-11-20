import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {poolFromEnv} from '../server/api.mjs';
const pool=poolFromEnv();
try{
  const sql=await readFile(fileURLToPath(new URL('../db/001_initial.sql',import.meta.url)),'utf8');
  await pool.query(sql);
  console.log('AQVORA Plus database initialized');
}catch(error){console.error(error);process.exitCode=1;}
finally{await pool.end();}

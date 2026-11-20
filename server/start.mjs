import {createApp,poolFromEnv} from './api.mjs';
const pool=poolFromEnv();
await pool.query('SELECT 1');
const port=Number(process.env.PORT||3000);
const server=createApp(pool,{production:process.env.NODE_ENV==='production'});
server.listen(port,()=>console.log('AQVORA Plus listening on port '+port));
async function shutdown(){server.close();await pool.end();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

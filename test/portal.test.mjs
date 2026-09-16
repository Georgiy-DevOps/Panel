import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { createApp } from '../server.mjs';

test('Client/admin boundaries, VIN registration and read-only ByteDepp integration',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bytedepp-portal-')),bytePath=join(dir,'source.sqlite');
  const source=new DatabaseSync(bytePath);source.exec(`CREATE TABLE devices(device_id TEXT PRIMARY KEY,vin TEXT,language_active INTEGER,language_expires_at INTEGER,store_active INTEGER,store_expires_at INTEGER,created_at INTEGER,updated_at INTEGER,telegram_id INTEGER,pair_code TEXT);`);
  const vin='L6T79D2D0PP123456',vin2='L6T79D2D0PP123457';
  source.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)').run('device-one',vin,1,0,1,Date.now()+86400000,1,2,123456,'SECRET');
  source.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)').run('device-two',vin2,1,0,1,Date.now()-1000,1,2,234567,'HIDDEN');
  const original=source.prepare('SELECT * FROM devices ORDER BY device_id').all();
  const password='administrator-password',salt='12'.repeat(16),config={dataDir:join(dir,'app'),bytePath,publicUrl:'http://127.0.0.1:3080',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex')};
  let app=await createApp(config);await new Promise(r=>app.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+app.address().port;
  const cookies={};
  async function call(role,path,body,options={}){const headers={Origin:config.publicUrl,...options.headers};if(cookies[role])headers.Cookie=cookies[role];if(body!==undefined)headers['Content-Type']='application/json';const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});const c=r.headers.get('set-cookie');if(c)cookies[role]=c.split(';')[0];return{status:r.status,body:await r.json(),cookie:c};}
  let car1,car2,adminCar,clientA,clientB;
  try{
    await t.test('pages are separate and admin is authenticated',async()=>{assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/admin')).status,200);assert.equal((await call('none','/state')).status,401);assert.equal((await call('admin','/login',{password},{headers:{Origin:'https://other.invalid'}})).status,403);assert.equal((await call('admin','/login',{password})).status,200);});
    await t.test('client signup validates password, creates a distinct session and blocks admin APIs',async()=>{
      assert.equal((await call('a','/client/register',{name:'A',email:'a@example.invalid',password:'short'})).status,400);
      const result=await call('a','/client/register',{name:'Alice',email:'a@example.invalid',password:'alice-test-password'});assert.equal(result.status,200);assert.match(result.cookie,/^fleet_client_session=/);assert.match(result.cookie,/HttpOnly; SameSite=Strict/);
      assert.equal((await call('b','/client/register',{name:'Bob',email:'b@example.invalid',password:'bob-test-password'})).status,200);
      assert.equal((await call('a','/state')).status,401);assert.equal((await call('admin','/client/state')).status,401);
    });
    await t.test('VIN registration appears to admin and stays private between clients',async()=>{
      assert.equal((await call('a','/client/vehicles',{vin:'INVALID'})).status,400);
      car1=(await call('a','/client/vehicles',{vin,brand:'Zeekr',model:'001',software:'client supplied'})).body;
      car2=(await call('b','/client/vehicles',{vin:vin2})).body;
      assert.equal((await call('b','/client/vehicles',{vin})).status,409);
      const a=(await call('a','/client/state')).body,b=(await call('b','/client/state')).body;
      assert.equal(a.vehicles.length,1);assert.equal(a.vehicles[0].vin,vin);assert.equal(a.vehicles[0].bytedepp,null);assert.equal(a.vehicles[0].link_status,'pending');assert.equal(b.vehicles[0].vin,vin2);
      const admin=(await call('admin','/state')).body;assert.equal(admin.vehicles.length,2);assert.equal(admin.clients.length,2);assert.deepEqual(admin.vehicles.find(v=>v.id===car1.id).matching_devices,['device-one']);assert.ok(!JSON.stringify(admin).includes('SECRET'));assert.ok(!JSON.stringify(admin).includes('password_hash'));assert.ok(!('online' in admin.vehicles[0]));
      assert.equal(admin.bytedepp.reporting_supported,false);assert.equal(admin.vehicles.find(v=>v.id===car1.id).software,null);
    });
    await t.test('only admin can approve matching device after explicit ownership confirmation',async()=>{
      const path=`/vehicles/${car1.id}/link`,body={device_id:'device-one',confirm_vin:vin,owner_verified:true};
      assert.equal((await call('a',path,body)).status,401);assert.equal((await call('admin',path,{...body,owner_verified:false})).status,400);
      assert.equal((await call('admin',path,{...body,device_id:'device-two'})).status,409);assert.equal((await call('admin',path,body,{headers:{Origin:'https://other.invalid'}})).status,403);assert.equal((await call('admin',path,body)).status,200);
      const a=(await call('a','/client/state')).body;assert.equal(a.vehicles[0].link_status,'linked');assert.equal(a.vehicles[0].bytedepp.language.active,true);assert.equal(a.vehicles[0].bytedepp.store.active,true);assert.ok(!JSON.stringify(a).includes('device-one'));assert.ok(!JSON.stringify(a).includes('b@example.invalid'));
    });
    await t.test('licenses are read live, expire correctly, and are not modified by linking',async()=>{
      assert.deepEqual(source.prepare('SELECT * FROM devices ORDER BY device_id').all(),original);
      const s=(await call('admin','/state')).body;assert.equal(s.bytedepp.devices.find(d=>d.device_id==='device-two').store.active,false);
      source.prepare('UPDATE devices SET store_active=0 WHERE device_id=?').run('device-one');assert.equal((await call('a','/client/state')).body.vehicles[0].bytedepp.store.active,false);
      source.prepare('UPDATE devices SET vin=? WHERE device_id=?').run(vin2,'device-one');const changed=(await call('a','/client/state')).body.vehicles[0];assert.equal(changed.link_status,'mismatch');assert.equal(changed.bytedepp,null);source.prepare('UPDATE devices SET vin=? WHERE device_id=?').run(vin,'device-one');
    });
    await t.test('restart retains links and sessions; old update routes are absent',async()=>{
      await new Promise(r=>app.close(r));app=await createApp(config);await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;
      assert.equal((await call('a','/client/state')).body.vehicles[0].link_status,'linked');assert.equal((await call('admin','/packages',{})).status,404);assert.equal((await call('admin','/assignments',{})).status,404);assert.equal((await call('admin','/agent/apk')).status,404);
    });
    await t.test('unlink hides services without changing ByteDepp; client logout invalidates its cookie',async()=>{
      const before=source.prepare('SELECT * FROM devices ORDER BY device_id').all();assert.equal((await call('admin',`/vehicles/${car1.id}/unlink`,{confirm_vin:vin})).status,200);assert.equal((await call('a','/client/state')).body.vehicles[0].bytedepp,null);assert.deepEqual(source.prepare('SELECT * FROM devices ORDER BY device_id').all(),before);
      const old=cookies.a;await call('a','/client/logout',{});cookies.a=old;assert.equal((await call('a','/client/state')).status,401);assert.equal((await call('a','/client/login',{email:'a@example.invalid',password:'wrong'})).status,401);assert.equal((await call('a','/client/login',{email:'a@example.invalid',password:'alice-test-password'})).status,200);
    });
    await t.test('admin adds a VIN with or without a client; invalid or duplicate VINs are rejected',async()=>{
      const clients=(await call('admin','/state')).body.clients;clientA=clients.find(c=>c.email==='a@example.invalid').id;clientB=clients.find(c=>c.email==='b@example.invalid').id;
      const vin3='L6T79D2D0PP123458',vin4='L6T79D2D0PP123459';
      assert.equal((await call('none','/vehicles',{vin:vin3})).status,401);
      assert.equal((await call('a','/vehicles',{vin:vin3})).status,401);
      assert.equal((await call('admin','/vehicles',{vin:vin3},{headers:{Origin:'https://other.invalid'}})).status,403);
      for(const invalid of['INVALID','L6T79D2D0PP12345I',123,{},null])assert.equal((await call('admin','/vehicles',{vin:invalid})).status,400);
      assert.equal((await call('admin','/vehicles',{vin:vin3,client_id:'missing'})).status,400);
      assert.equal((await call('admin','/vehicles',{vin:vin3,brand:'Other'})).status,400);
      const added=await call('admin','/vehicles',{vin:'  '+vin3.toLowerCase()+'  '});assert.equal(added.status,201);adminCar=added.body;
      const stored=(await call('admin','/state')).body.vehicles.find(v=>v.id===adminCar.id);assert.equal(stored.vin,vin3);assert.equal(stored.client_id,null);assert.equal(stored.brand,'Не указана');assert.equal(stored.link_status,'pending');
      for(const role of['a','b'])assert.equal((await call(role,'/client/state')).body.vehicles.some(v=>v.id===adminCar.id),false);
      assert.equal((await call('admin','/vehicles',{vin:vin3})).status,409);assert.equal((await call('a','/client/vehicles',{vin:vin3})).status,409);
      const assigned=await call('admin','/vehicles',{vin:vin4,client_id:clientA,brand:'Lynk & Co',model:'09',software:'1.2',region:'Москва'});assert.equal(assigned.status,201);
      const car=(await call('a','/client/state')).body.vehicles.find(v=>v.id===assigned.body.id);assert.equal(car.vin,vin4);assert.equal(car.software,null);assert.equal(car.reported_vin,null);assert.equal(car.bytedepp,null);
      assert.equal((await call('b','/client/state')).body.vehicles.some(v=>v.id===assigned.body.id),false);
    });
    await t.test('admin assigns, transfers and removes clients while preserving cabinet isolation',async()=>{
      const path=`/vehicles/${adminCar.id}/client`,body={client_id:clientA,confirm_vin:'L6T79D2D0PP123458'};
      assert.equal((await call('a',path,body)).status,401);assert.equal((await call('admin',path,body,{headers:{Origin:'https://other.invalid'}})).status,403);
      assert.equal((await call('admin',path,{...body,confirm_vin:vin})).status,400);assert.equal((await call('admin',path,{...body,client_id:'missing'})).status,400);
      assert.equal((await call('admin',path,body)).status,200);assert.equal((await call('a','/client/state')).body.vehicles.some(v=>v.id===adminCar.id),true);assert.equal((await call('b','/client/state')).body.vehicles.some(v=>v.id===adminCar.id),false);
      assert.equal((await call('admin',path,{...body,client_id:clientB})).status,200);assert.equal((await call('a','/client/state')).body.vehicles.some(v=>v.id===adminCar.id),false);assert.equal((await call('b','/client/state')).body.vehicles.some(v=>v.id===adminCar.id),true);
      assert.equal((await call('admin',path,{...body,client_id:null})).status,200);assert.equal((await call('b','/client/state')).body.vehicles.some(v=>v.id===adminCar.id),false);
      const s=(await call('admin','/state')).body;assert.equal(s.vehicles.find(v=>v.id===adminCar.id).client_id,null);assert.ok(s.events.some(e=>e.action==='Администратор добавил автомобиль'));assert.ok(s.events.some(e=>e.action==='Клиент автомобиля снят'));
    });
    await t.test('unassigned cars can link to ByteDepp; client assignment requires verification and persists',async()=>{
      const path=`/vehicles/${car1.id}/client`,before=source.prepare('SELECT * FROM devices ORDER BY device_id').all();
      assert.equal((await call('admin',path,{client_id:null,confirm_vin:vin})).status,200);
      assert.equal((await call('admin',`/vehicles/${car1.id}/link`,{device_id:'device-one',confirm_vin:vin,owner_verified:true})).status,200);
      const body={client_id:clientB,confirm_vin:vin};assert.equal((await call('admin',path,body)).status,400);assert.equal((await call('b','/client/state')).body.vehicles.some(v=>v.id===car1.id),false);
      assert.equal((await call('admin',path,{...body,owner_verified:true})).status,200);assert.equal((await call('a','/client/state')).body.vehicles.some(v=>v.id===car1.id),false);assert.equal((await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id).bytedepp.language.active,true);
      assert.deepEqual(source.prepare('SELECT * FROM devices ORDER BY device_id').all(),before);
      await new Promise(r=>app.close(r));app=await createApp(config);await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;
      assert.equal((await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id).link_status,'linked');assert.equal((await call('admin','/state')).body.vehicles.find(v=>v.id===adminCar.id).client_id,null);
    });
    await t.test('car VIN and software come only from matching ByteDepp reports and update live',async()=>{
      source.exec('ALTER TABLE devices ADD COLUMN vehicle_software_version TEXT; ALTER TABLE devices ADD COLUMN vin_reported_at INTEGER; ALTER TABLE devices ADD COLUMN vehicle_software_reported_at INTEGER;');
      source.prepare('UPDATE devices SET vehicle_software_version=?,vin_reported_at=?,vehicle_software_reported_at=? WHERE device_id=?').run('ZEEKR OS 6.3',100,200,'device-one');
      let s=(await call('admin','/state')).body;assert.equal(s.bytedepp.reporting_supported,true);const car=s.vehicles.find(v=>v.id===car1.id);assert.equal(car.software,'ZEEKR OS 6.3');assert.equal(car.reported_vin,vin);assert.equal(car.software_reported_at,200);
      assert.equal((await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id).software,'ZEEKR OS 6.3');assert.equal((await call('a','/client/state')).body.vehicles.some(v=>v.id===car1.id),false);
      source.prepare('UPDATE devices SET vehicle_software_version=?,vehicle_software_reported_at=? WHERE device_id=?').run('ZEEKR OS 6.4',300,'device-one');
      assert.equal((await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id).software,'ZEEKR OS 6.4');
      for(const mismatchingVin of[vin2,'']){
        source.prepare('UPDATE devices SET vin=? WHERE device_id=?').run(mismatchingVin,'device-one');
        const hidden=(await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id);assert.equal(hidden.software,null);assert.equal(hidden.reported_vin,null);assert.equal(hidden.software_reported_at,null);
      }
      source.prepare('UPDATE devices SET vin=? WHERE device_id=?').run(vin,'device-one');
      await call('admin',`/vehicles/${car1.id}/unlink`,{confirm_vin:vin});assert.equal((await call('b','/client/state')).body.vehicles.find(v=>v.id===car1.id).software,null);
    });
  }finally{await new Promise(r=>app.close(r));source.close();const target=resolveSafe(dir);await rm(target,{recursive:true,force:true});}
});
function resolveSafe(dir){if(!dir.startsWith(join(tmpdir(),'bytedepp-portal-')))throw new Error('Unsafe test cleanup');return dir;}

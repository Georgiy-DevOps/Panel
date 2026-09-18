import { randomUUID } from 'node:crypto';
import { services, statuses, transitions, activeStatuses, moscowDate } from './public/service-catalog.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function text(value,label,max,required=false){
  if(value===undefined||value===null)value='';
  if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b-\x1f\x7f]/.test(value)||required&&!value.trim())fail(400,`Проверьте поле «${label}»`);
  return value.trim();
}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(400,'Укажите корректную дату');
  if(value<moscowDate()||value>moscowDate(Date.now()+180*86400000))fail(400,'Выберите дату от сегодня до 180 дней вперёд');
  return value;
}
function time(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail(400,'Укажите время в формате ЧЧ:ММ');return value;}

export function createAppointments(db,audit){
  db.exec(`CREATE TABLE IF NOT EXISTS appointments(
    id TEXT PRIMARY KEY,request_key TEXT NOT NULL,client_id TEXT NOT NULL REFERENCES clients(id),vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
    vin TEXT NOT NULL,brand TEXT NOT NULL,model TEXT NOT NULL,service TEXT NOT NULL,phone TEXT NOT NULL,mileage INTEGER,
    preferred_date TEXT NOT NULL,preferred_time TEXT NOT NULL,description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',scheduled_at INTEGER,address TEXT NOT NULL DEFAULT '',staff_note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(client_id,request_key));
    CREATE INDEX IF NOT EXISTS appointments_client ON appointments(client_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_service ON appointments(vehicle_id,service) WHERE status IN ('new','confirmed','in_progress');
    CREATE TABLE IF NOT EXISTS appointment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,appointment_id TEXT NOT NULL REFERENCES appointments(id),
    status TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS appointment_events_request ON appointment_events(appointment_id,id);`);
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
  const event=(id,status,actor,note)=>run('INSERT INTO appointment_events(appointment_id,status,actor,note,created_at) VALUES(?,?,?,?,?)',id,status,actor,note,Date.now());
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  function list(clientId){
    const rows=clientId?all('SELECT * FROM appointments WHERE client_id=? ORDER BY created_at DESC,id',clientId):all('SELECT a.*,c.name AS client_name,c.email AS client_email FROM appointments a JOIN clients c ON c.id=a.client_id ORDER BY a.created_at DESC,a.id');
    return rows.map(({request_key,...row})=>({...row,history:all('SELECT status,actor,note,created_at FROM appointment_events WHERE appointment_id=? ORDER BY id',row.id)}));
  }
  function create(user,b){return transaction(()=>{
    const requestKey=text(b.request_key,'Идентификатор заявки',36,true);
    if(!/^[0-9a-f-]{36}$/.test(requestKey))fail(400,'Некорректный идентификатор заявки');
    const existing=one('SELECT id FROM appointments WHERE client_id=? AND request_key=?',user.id,requestKey);
    if(existing)return{...existing,replayed:true};
    const vehicle=one('SELECT * FROM vehicles WHERE id=? AND client_id=?',text(b.vehicle_id,'Автомобиль',36,true),user.id);
    if(!vehicle)fail(404,'Автомобиль не найден в вашем кабинете');
    if(!services.some(s=>s.id===b.service))fail(400,'Выберите услугу из списка');
    if(one("SELECT id FROM appointments WHERE vehicle_id=? AND service=? AND status IN ('new','confirmed','in_progress')",vehicle.id,b.service))fail(409,'По этой услуге уже есть активная заявка для автомобиля');
    if(one("SELECT COUNT(*) AS n FROM appointments WHERE client_id=? AND status IN ('new','confirmed','in_progress')",user.id).n>=5)fail(409,'Можно иметь не более пяти активных заявок');
    if(one('SELECT COUNT(*) AS n FROM appointments WHERE client_id=? AND created_at>?',user.id,Date.now()-3600000).n>=10)fail(429,'Слишком много заявок. Повторите через час');
    const phone=text(b.phone,'Телефон',32,true);
    if(!/^\+?[0-9 ()-]+$/.test(phone)||phone.replace(/\D/g,'').length<10||phone.replace(/\D/g,'').length>15)fail(400,'Укажите телефон: от 10 до 15 цифр');
    const preferredDate=date(b.preferred_date),preferredTime=b.preferred_time?time(b.preferred_time):'';
    if(preferredTime&&Date.parse(`${preferredDate}T${preferredTime}:00+03:00`)<=Date.now())fail(400,'Желаемое время уже прошло');
    const description=text(b.description,'Описание',2000);
    const mileage=b.mileage===undefined||b.mileage===null||b.mileage===''?null:Number(b.mileage);
    if(mileage!==null&&(!['string','number'].includes(typeof b.mileage)||!Number.isInteger(mileage)||mileage<0||mileage>2000000))fail(400,'Пробег должен быть целым числом от 0 до 2 000 000 км');
    const id=randomUUID(),created=Date.now();
    run(`INSERT INTO appointments(id,request_key,client_id,vehicle_id,vin,brand,model,service,phone,mileage,preferred_date,preferred_time,description,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,requestKey,user.id,vehicle.id,vehicle.vin,vehicle.brand,vehicle.model,b.service,phone,mileage,preferredDate,preferredTime,description,created,created);
    event(id,'new','client','Заявка отправлена. Ожидайте подтверждения даты и адреса.');audit('client','Создана заявка на сервис',id+' · '+vehicle.vin);
    return{id,replayed:false};
  });}
  function get(id,version,clientId){
    const a=clientId?one('SELECT * FROM appointments WHERE id=? AND client_id=?',id,clientId):one('SELECT * FROM appointments WHERE id=?',id);
    if(!a)fail(404,'Заявка не найдена');
    if(!Number.isInteger(version)||a.version!==version)fail(409,'Заявка уже изменена. Обновите данные и откройте её заново');
    return a;
  }
  function cancel(user,id,b){return transaction(()=>{
    const a=get(id,b.version,user.id);
    if(!['new','confirmed'].includes(a.status))fail(409,'Эту заявку уже нельзя отменить из кабинета');
    run("UPDATE appointments SET status='cancelled',version=version+1,updated_at=? WHERE id=?",Date.now(),id);
    event(id,'cancelled','client','Отменена клиентом');audit('client','Клиент отменил заявку',id);return{ok:true};
  });}
  function update(id,b){return transaction(()=>{
    const a=get(id,b.version);
    if(!transitions[a.status]?.includes(b.status))fail(409,'Недопустимое изменение статуса заявки');
    if(activeStatuses.includes(b.status)&&one('SELECT client_id FROM vehicles WHERE id=?',a.vehicle_id)?.client_id!==a.client_id)fail(409,'Автомобиль больше не назначен этому клиенту');
    const note=text(b.staff_note,'Комментарий клиенту',2000);
    let scheduled=a.scheduled_at,address=a.address;
    if(b.status==='confirmed'){
      scheduled=Date.parse(`${date(b.scheduled_date)}T${time(b.scheduled_time)}:00+03:00`);
      if(scheduled<=Date.now())fail(400,'Подтверждённое время должно быть в будущем');
      address=text(b.address,'Адрес визита',500,true);
    }
    if(['completed','cancelled'].includes(b.status)&&!note)fail(400,b.status==='completed'?'Укажите результат работ для клиента':'Укажите причину отмены');
    if(b.status===a.status&&scheduled===a.scheduled_at&&address===a.address&&note===a.staff_note)return{ok:true};
    run('UPDATE appointments SET status=?,scheduled_at=?,address=?,staff_note=?,version=version+1,updated_at=? WHERE id=?',b.status,scheduled,address,note,Date.now(),id);
    const details=b.status==='confirmed'?`Визит: ${new Date(scheduled).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК. Адрес: ${address}. ${note}`:note||statuses[b.status];
    event(id,b.status,'admin',details);audit('admin','Заявка: '+statuses[b.status],id);return{ok:true};
  });}
  // History belongs to the requesting client. A new owner never receives their contact details.
  function transfer(vehicleId){
    for(const a of all("SELECT id FROM appointments WHERE vehicle_id=? AND status IN ('new','confirmed','in_progress')",vehicleId)){
      const note='Заявка закрыта: администратор изменил назначение автомобиля клиенту.';
      run("UPDATE appointments SET status='cancelled',staff_note=?,version=version+1,updated_at=? WHERE id=?",note,Date.now(),a.id);
      event(a.id,'cancelled','admin',note);audit('admin','Заявка отменена при смене клиента',a.id);
    }
  }
  return{list,create,cancel,update,transfer};
}

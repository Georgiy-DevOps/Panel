import { DatabaseSync } from 'node:sqlite';

// Read-only adapter: the original ByteDepp service remains the source of license data.
// updated_at is a record modification time, not proof that a car is currently online.
export function readByteDepp(path) {
  if (!path) return { connected:false, error:'Источник ByteDepp не настроен', devices:[] };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly:true, timeout:1000 });
    const columns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(c=>c.name));
    const reportFields = ['vehicle_software_version','vin_reported_at','vehicle_software_reported_at'];
    const reportingSupported = reportFields.every(c=>columns.has(c));
    const reportSql = reportFields.map(c=>columns.has(c)?c:`NULL AS ${c}`).join(',');
    const rows = db.prepare(`SELECT device_id,vin,language_active,language_expires_at,store_active,store_expires_at,created_at,updated_at,${reportSql} FROM devices ORDER BY updated_at DESC LIMIT 5000`).all();
    const active = (enabled, expires) => !!enabled && (!expires || expires > Date.now());
    return { connected:true, reporting_supported:reportingSupported, devices:rows.map(d=>({
      device_id:d.device_id,vin:(d.vin || '').trim().toUpperCase(),
      vehicle_software_version:d.vehicle_software_version||null,
      vin_reported_at:d.vin_reported_at,vehicle_software_reported_at:d.vehicle_software_reported_at,
      language:{ active:active(d.language_active,d.language_expires_at),expires_at:d.language_expires_at },
      store:{ active:active(d.store_active,d.store_expires_at),expires_at:d.store_expires_at },
      created_at:d.created_at,updated_at:d.updated_at
    })) };
  } catch { return { connected:false,error:'Не удалось прочитать данные ByteDepp',devices:[] }; }
  finally { if(db) db.close(); }
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data.sqlite');
const PORT = Number(process.env.PORT || 3000);
fs.mkdirSync(PUBLIC, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('superadmin','admin','candidate')), name TEXT NOT NULL, group_name TEXT DEFAULT '', squad TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', avatar TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stages (id INTEGER PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL, icon TEXT NOT NULL, accent TEXT NOT NULL, sort_order INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stamps (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, admin_id INTEGER NOT NULL, note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, stage_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(stage_id) REFERENCES stages(id), FOREIGN KEY(admin_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS missions (id INTEGER PRIMARY KEY AUTOINCREMENT, stage_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL, sort_order INTEGER NOT NULL, FOREIGN KEY(stage_id) REFERENCES stages(id));
CREATE TABLE IF NOT EXISTS mission_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, mission_id INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, proof TEXT DEFAULT '', proof_image TEXT DEFAULT '', completed_at TEXT, UNIQUE(user_id, mission_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, stage_id INTEGER, event_date TEXT NOT NULL, time_start TEXT DEFAULT '', time_end TEXT DEFAULT '', location TEXT DEFAULT '', description TEXT DEFAULT '', program TEXT DEFAULT '', organizer TEXT DEFAULT '', contact TEXT DEFAULT '', materials TEXT DEFAULT '', type TEXT DEFAULT 'ШМБ', sort_order INTEGER DEFAULT 0, FOREIGN KEY(stage_id) REFERENCES stages(id));
CREATE TABLE IF NOT EXISTS event_registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_id INTEGER NOT NULL, status TEXT DEFAULT 'registered', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,event_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target_user_id INTEGER, payload TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(admin_id) REFERENCES users(id));`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('users', 'avatar', "TEXT DEFAULT ''");
ensureColumn('mission_progress', 'proof_image', "TEXT DEFAULT ''");
ensureColumn('events', 'program', "TEXT DEFAULT ''");
ensureColumn('events', 'organizer', "TEXT DEFAULT ''");
ensureColumn('events', 'contact', "TEXT DEFAULT ''");
ensureColumn('events', 'materials', "TEXT DEFAULT ''");
ensureColumn('users', 'pd_consent', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('users', 'pd_consent_at', "TEXT DEFAULT ''");
ensureColumn('stages', 'points', "INTEGER NOT NULL DEFAULT 10");
ensureColumn('missions', 'points', "INTEGER NOT NULL DEFAULT 5");
ensureColumn('events', 'points', "INTEGER NOT NULL DEFAULT 3");
ensureColumn('events', 'visibility', "TEXT NOT NULL DEFAULT 'open'");
ensureColumn('events', 'audience', "TEXT NOT NULL DEFAULT 'all'");
ensureColumn('events', 'target_squad', "TEXT DEFAULT ''");
ensureColumn('events', 'category_id', "INTEGER");
db.exec(`
CREATE TABLE IF NOT EXISTS event_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bonus_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(admin_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS scoring_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  target_points INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO scoring_settings(id,target_points,enabled) VALUES(1,100,1);
CREATE TABLE IF NOT EXISTS event_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'absent',
  points_override INTEGER,
  note TEXT DEFAULT '',
  marked_by INTEGER,
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id,user_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(marked_by) REFERENCES users(id)
);

`);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}
function validImage(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && !/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
  return value.length <= 2_500_000;
}
function clean(v, max = 5000) { return String(v ?? '').trim().slice(0, max); }

function seed() {
  if (!db.prepare('SELECT id FROM stages LIMIT 1').get()) {
    const stages = [
      [1,'ПРОЯВИСЬ','Покажи себя в команде','🔥','#1f6b4f',1],
      [2,'СОЗДАЙ','Оставь свой след','📸','#355fa8',2],
      [3,'ПОМОГИ','Сделай добро вместе с отрядом','♥','#c99118',3],
      [4,'НАУЧИСЬ','Освой навыки бойца','⚙','#7154a6',4],
      [5,'ПОКАЖИ','Докажи, на что способен','🏆','#b44b3d',5],
      [6,'СТАНЬ','Сделай последний шаг','✦','#173f34',6]
    ];
    const s = db.prepare('INSERT INTO stages(id,title,subtitle,icon,accent,sort_order) VALUES(?,?,?,?,?,?)'); stages.forEach(x => s.run(...x));
    const ms = [
      [1,'Найди свою силу','Определи, какую роль ты чаще всего берёшь в команде.','2026-10-19','2026-10-25',1],
      [2,'Покажи отряд','Сделай фото или короткое видео, которое передаёт атмосферу студенческих отрядов.','2026-10-26','2026-11-01',2],
      [3,'Отряд помогает','Участвуй в донорской акции или выполни альтернативную социальную миссию.','2026-11-02','2026-11-08',3],
      [4,'Научись','Освой один новый практический навык.','2026-11-09','2026-11-15',4],
      [5,'Мой выбор','Сформулируй, что ты можешь дать отряду и чему хочешь научиться.','2026-11-16','2026-11-19',5]
    ];
    const m = db.prepare('INSERT INTO missions(stage_id,title,description,date_from,date_to,sort_order) VALUES(?,?,?,?,?,?)'); ms.forEach(x => m.run(...x));
  }
  if (!db.prepare('SELECT id FROM events LIMIT 1').get()) {
    const ev = [
      [1,'Проверь себя',1,'2026-10-19','18:30','20:00','Актовый зал','Старт ШМБ: командная игра, 5 испытаний и формирование команд.','Вводная, командная игра.','Штаб студенческих отрядов','ОМПиВР','Паспорт кандидата, ручка','ШМБ',1],
      [2,'Боец в кадре',2,'2026-10-26','18:30','20:10','Медиазона','Мастер-класс и медиабаттл: создаём контент за ограниченное время.','Разбор идеи → съёмка → монтаж → показ работ.','Штаб студенческих отрядов','ОМПиВР','Смартфон, зарядка','ШМБ',2],
      [3,'Отряд помогает',3,'2026-11-02','09:00','13:00','Донорская площадка','Социальная миссия кандидатов. Участие добровольное, предусмотрена альтернативная миссия.','Сбор → инструктаж → участие в акции → общее фото.','Штаб студенческих отрядов','По информации организатора акции','Документ удостоверяющий личность; требования уточняются у организатора','Акция',3],
      [4,'Боец должен уметь',4,'2026-11-09','18:30','20:00','Актовый зал','Пять практических станций: первая помощь, выступление, организация, форс-мажор и команда.','5 станций по 12 минут → общий разбор.','Штаб студенческих отрядов','ОМПиВР','Удобная одежда','ШМБ',4],
      [5,'Битва кандидатов',5,'2026-11-16','18:30','20:30','Актовый зал','Большое финальное испытание: квиз, дух, кейсы, медиа и защита проекта.','Квиз → творческое задание → кейсы → медиа → защита.','Штаб студенческих отрядов','ОМПиВР','Паспорт кандидата','ШМБ',5],
      [6,'Ты готов стать бойцом?',6,'2026-11-20','18:30','20:00','Актовый зал','Финальная рефлексия, вручение паспортов и торжественное завершение ШМБ.','Хроника → рефлексия → обращение командиров → вручение → фото.','Штаб студенческих отрядов','ОМПиВР','Паспорт кандидата','Финал',6]
    ];
    const e = db.prepare('INSERT INTO events(id,title,stage_id,event_date,time_start,time_end,location,description,program,organizer,contact,materials,type,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'); ev.forEach(x => e.run(...x));
  }
  const cat = db.prepare('INSERT OR IGNORE INTO event_categories(name,description,sort_order) VALUES(?,?,?)');
  [['ШМБ','Основные занятия и мероприятия школы молодого бойца',1],['Добровольчество','Социальные, донорские и волонтёрские акции',2],['Отряды','Мероприятия конкретных студенческих отрядов',3]].forEach(x=>cat.run(...x));
  db.prepare("UPDATE stages SET points=COALESCE(points,10) WHERE points IS NULL OR points=0").run();
  db.prepare("UPDATE missions SET points=COALESCE(points,5) WHERE points IS NULL OR points=0").run();
  db.prepare("UPDATE events SET points=COALESCE(points,3), visibility=COALESCE(visibility,'open'), audience=COALESCE(audience,'all') WHERE points IS NULL OR points=0 OR visibility IS NULL OR audience IS NULL").run();
  if (!db.prepare('SELECT id FROM users WHERE username=?').get('admin')) db.prepare('INSERT INTO users(username,password_hash,role,name) VALUES(?,?,?,?)').run('admin',hashPassword('ChangeMe123!'),'superadmin','Главный администратор');
  const add = db.prepare('INSERT OR IGNORE INTO users(username,password_hash,role,name,group_name,squad,phone) VALUES(?,?,?,?,?,?,?)');
  [['dima','Дмитрий Вихлянцев','candidate','ИС-26','«Вояж»','+7 900 000-00-01'],['anna','Анна Морозова','candidate','П-26','«Цитрус»','+7 900 000-00-02'],['max','Максим Орлов','candidate','ТХ-26','','+7 900 000-00-03']].forEach(c => add.run(c[0],hashPassword('Candidate123!'),c[2],c[1],c[3],c[4],c[5]));
}
seed();

const sessions = new Map();
const token = () => crypto.randomBytes(32).toString('hex');
function currentUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )smb_session=([^;]+)/);
  if (!m) return null;
  const id = sessions.get(m[1]);
  return id ? db.prepare('SELECT id,username,role,name,group_name,squad,phone,email,avatar,status FROM users WHERE id=?').get(id) : null;
}
function send(res,status,data,headers={}) {
  const body = Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {'Content-Type': Buffer.isBuffer(data) ? 'application/octet-stream' : typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers});
  res.end(body);
}
const json = (res,status,data,h={}) => send(res,status,data,{'Cache-Control':'no-store',...h});
async function body(req) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',c=>{ raw += c; if(raw.length > 5_000_000) req.destroy(); });
    req.on('end',()=>{ try { resolve(raw ? JSON.parse(raw) : {}); } catch(e) { reject(e); } });
    req.on('error',reject);
  });
}
function requireAuth(req,res,roles=[]) {
  const u=currentUser(req);
  if(!u){ json(res,401,{error:'Требуется авторизация'}); return null; }
  if(roles.length && !roles.includes(u.role)){ json(res,403,{error:'Недостаточно прав'}); return null; }
  return u;
}
const audit = (adminId,action,target,payload='') => db.prepare('INSERT INTO audit_log(admin_id,action,target_user_id,payload) VALUES(?,?,?,?)').run(adminId,action,target,payload);

function scoreView(id) {
  const stamps = db.prepare(`SELECT COALESCE(SUM(st.points),0) n FROM stamps s JOIN stages st ON st.id=s.stage_id WHERE s.user_id=?`).get(id).n;
  const missions = db.prepare(`SELECT COALESCE(SUM(m.points),0) n FROM mission_progress mp JOIN missions m ON m.id=mp.mission_id WHERE mp.user_id=? AND mp.completed=1`).get(id).n;
  const attendance = db.prepare(`SELECT COALESCE(SUM(COALESCE(ea.points_override,e.points)),0) n FROM event_attendance ea JOIN events e ON e.id=ea.event_id WHERE ea.user_id=? AND ea.status='present'`).get(id).n;
  const bonus = db.prepare(`SELECT COALESCE(SUM(points),0) n FROM bonus_points WHERE user_id=?`).get(id).n;
  const total = stamps + missions + attendance + bonus;
  const target = Math.max(1, Number(db.prepare('SELECT target_points FROM scoring_settings WHERE id=1').get()?.target_points || 100));
  return {stamps,missions,attendance,bonus,total,target,progress:Math.min(100,Math.round(total/target*100))};
}
function userView(id) {
  const u=db.prepare('SELECT id,username,role,name,group_name,squad,phone,email,avatar,status,created_at,pd_consent,pd_consent_at FROM users WHERE id=?').get(id);
  if(!u) return null;
  const stamps=db.prepare(`SELECT s.id,s.stage_id,s.note,s.created_at,st.title,st.subtitle,st.icon,st.accent,st.points,a.name admin_name FROM stamps s JOIN stages st ON st.id=s.stage_id JOIN users a ON a.id=s.admin_id WHERE s.user_id=? ORDER BY st.sort_order`).all(id);
  const missions=db.prepare(`SELECT m.*,COALESCE(mp.completed,0) completed,mp.proof,mp.proof_image,mp.completed_at FROM missions m LEFT JOIN mission_progress mp ON mp.mission_id=m.id AND mp.user_id=? ORDER BY m.sort_order`).all(id);
  const events=db.prepare(`SELECT e.*,ec.name category_name,COALESCE(er.status,'') registration_status,
    CASE WHEN e.audience='all' OR (e.audience='squad' AND e.target_squad=?) THEN 1 ELSE 0 END visible_to_user
    FROM events e LEFT JOIN event_categories ec ON ec.id=e.category_id
    LEFT JOIN event_registrations er ON er.event_id=e.id AND er.user_id=? ORDER BY e.event_date,e.time_start`).all(u.squad||'',id);
  const score=scoreView(id);
  const bonuses=db.prepare(`SELECT b.*,a.name admin_name FROM bonus_points b JOIN users a ON a.id=b.admin_id WHERE b.user_id=? ORDER BY b.id DESC`).all(id);
  return {...u,stamps,missions,events:events.filter(e=>e.visible_to_user),bonuses,score,progress:score.progress,totalStages:db.prepare('SELECT COUNT(*) n FROM stages').get().n};
}
function eventView(id, userId=null) {
  const e=db.prepare(`SELECT e.*,st.title stage_title,ec.name category_name FROM events e
    LEFT JOIN stages st ON st.id=e.stage_id LEFT JOIN event_categories ec ON ec.id=e.category_id WHERE e.id=?`).get(id);
  if(!e) return null;
  if(userId) {
    const u=db.prepare('SELECT squad FROM users WHERE id=?').get(userId);
    e.registration_status=db.prepare('SELECT status FROM event_registrations WHERE event_id=? AND user_id=?').get(id,userId)?.status || '';
    e.attendance_status=db.prepare('SELECT status FROM event_attendance WHERE event_id=? AND user_id=?').get(id,userId)?.status || '';
    e.visible_to_user=e.audience==='all'||(e.audience==='squad'&&e.target_squad===(u?.squad||''));
  }
  e.registrations=db.prepare('SELECT COUNT(*) n FROM event_registrations WHERE event_id=?').get(id).n;
  return e;
}

async function api(req,res,url) {
  const user=currentUser(req);
  if(req.method==='POST'&&url==='/api/login'){
    const b=await body(req); const u=db.prepare("SELECT * FROM users WHERE username=? AND status='active'").get(clean(b.username,100));
    if(!u||!verifyPassword(String(b.password||''),u.password_hash)) return json(res,401,{error:'Неверный логин или пароль'});
    const t=token(); sessions.set(t,u.id);
    return json(res,200,{user:{id:u.id,username:u.username,role:u.role,name:u.name,group_name:u.group_name,squad:u.squad,phone:u.phone,email:u.email,avatar:u.avatar}},{'Set-Cookie':`smb_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`});
  }
  if(req.method==='POST'&&url==='/api/register'){
    const b=await body(req);
    const username=clean(b.username,100), password=String(b.password||'');
    if(!username||username.length<3||!clean(b.name,120)||password.length<8) return json(res,400,{error:'Заполните имя, логин и пароль (не менее 8 символов)'});
    if(!b.pd_consent) return json(res,400,{error:'Необходимо согласие на обработку персональных данных'});
    try{
      const r=db.prepare(`INSERT INTO users(username,password_hash,role,name,group_name,squad,phone,email,avatar,pd_consent,pd_consent_at) VALUES(?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)`)
        .run(username,hashPassword(password), 'candidate', clean(b.name,120),clean(b.group_name,120),clean(b.squad,120),clean(b.phone,80),clean(b.email,160),b.avatar||'');
      const t=token(); sessions.set(t,Number(r.lastInsertRowid));
      return json(res,201,{user:db.prepare('SELECT id,username,role,name,group_name,squad,phone,email,avatar FROM users WHERE id=?').get(Number(r.lastInsertRowid))},{'Set-Cookie':`smb_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`});
    }catch(e){return json(res,400,{error:'Такой логин уже существует'})}
  }
  if(req.method==='POST'&&url==='/api/logout'){
    const m=(req.headers.cookie||'').match(/(?:^|; )smb_session=([^;]+)/); if(m)sessions.delete(m[1]);
    return json(res,200,{ok:true},{'Set-Cookie':'smb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  if(url==='/api/me') return json(res,200,{user});

  if(url.startsWith('/api/public/candidate/')&&req.method==='GET'){
    const id=Number(url.split('/').pop()),v=userView(id); if(!v)return json(res,404,{error:'Профиль не найден'});
    return json(res,200,{id:v.id,name:v.name,squad:v.squad,group_name:v.group_name,avatar:v.avatar,progress:v.progress,totalStages:v.totalStages,score:v.score,stamps:v.stamps.map(s=>({stage_id:s.stage_id,title:s.title,icon:s.icon,created_at:s.created_at}))});
  }

  if(url==='/api/passport'&&req.method==='GET'){
    const u=requireAuth(req,res); if(!u)return;
    return json(res,200,{user:userView(u.id),stages:db.prepare('SELECT * FROM stages ORDER BY sort_order').all()});
  }
  if(url==='/api/profile'&&req.method==='PUT'){
    const u=requireAuth(req,res); if(!u)return;
    const b=await body(req); if(!clean(b.name,120))return json(res,400,{error:'Имя не может быть пустым'}); if(!validImage(b.avatar))return json(res,400,{error:'Фото имеет неверный формат или слишком большое'});
    db.prepare('UPDATE users SET name=?,group_name=?,squad=?,phone=?,email=?,avatar=? WHERE id=?').run(clean(b.name,120),clean(b.group_name,120),clean(b.squad,120),clean(b.phone,80),clean(b.email,160),b.avatar||'',u.id);
    return json(res,200,{user:db.prepare('SELECT id,username,role,name,group_name,squad,phone,email,avatar,status FROM users WHERE id=?').get(u.id)});
  }
  if(url==='/api/mission'&&req.method==='POST'){
    const u=requireAuth(req,res); if(!u)return; const b=await body(req),mid=Number(b.mission_id);
    if(!db.prepare('SELECT id FROM missions WHERE id=?').get(mid))return json(res,404,{error:'Миссия не найдена'});
    if(!validImage(b.proof_image))return json(res,400,{error:'Фото имеет неверный формат или слишком большое'});
    db.prepare(`INSERT INTO mission_progress(user_id,mission_id,completed,proof,proof_image,completed_at) VALUES(?,?,1,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,mission_id) DO UPDATE SET completed=1,proof=excluded.proof,proof_image=excluded.proof_image,completed_at=CURRENT_TIMESTAMP`).run(u.id,mid,clean(b.proof,1000),b.proof_image||'');
    return json(res,200,{ok:true});
  }
  if(url==='/api/event/register'&&req.method==='POST'){
    const u=requireAuth(req,res); if(!u)return; const b=await body(req),eid=Number(b.event_id);
    const ev=db.prepare('SELECT * FROM events WHERE id=?').get(eid); if(!ev)return json(res,404,{error:'Событие не найдено'});
    if(ev.visibility==='closed')return json(res,403,{error:'Это закрытое мероприятие: регистрация кандидатов отключена'});
    if(ev.audience==='squad' && ev.target_squad!==(u.squad||''))return json(res,403,{error:'Мероприятие предназначено для другого отряда'});
    db.prepare(`INSERT INTO event_registrations(user_id,event_id,status) VALUES(?,?,?) ON CONFLICT(user_id,event_id) DO UPDATE SET status=excluded.status`).run(u.id,eid,'registered');
    return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/event/')&&req.method==='GET'){
    const u=requireAuth(req,res); if(!u)return; const id=Number(url.split('/').pop()),e=eventView(id,u.id); if(!e)return json(res,404,{error:'Событие не найдено'}); return json(res,200,{event:e});
  }

  if(url==='/api/rating'&&req.method==='GET'){
    const u=requireAuth(req,res); if(!u)return;
    const rows=db.prepare(`SELECT id,name,squad,avatar FROM users WHERE role='candidate' AND status='active' ORDER BY name`).all()
      .map(x=>({...x,score:scoreView(x.id)})).sort((a,b)=>b.score.total-a.score.total||a.name.localeCompare(b.name,'ru'));
    return json(res,200,{rating:rows.map((x,i)=>({...x,rank:i+1}))});
  }
  if(url==='/api/admin/scoring'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    return json(res,200,{settings:db.prepare('SELECT * FROM scoring_settings WHERE id=1').get(),
      stages:db.prepare('SELECT id,title,points,sort_order FROM stages ORDER BY sort_order').all(),
      missions:db.prepare('SELECT id,title,points FROM missions ORDER BY sort_order,id').all(),
      events:db.prepare('SELECT id,title,points FROM events ORDER BY event_date,time_start,id').all()});
  }
  if(url==='/api/admin/scoring'&&req.method==='PUT'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req);
    const target=Math.max(1,Math.round(Number(b.target_points)||100));
    db.prepare('UPDATE scoring_settings SET target_points=?,enabled=? WHERE id=1').run(target,b.enabled===false?0:1);
    if(Array.isArray(b.stages)) b.stages.forEach(x=>db.prepare('UPDATE stages SET points=? WHERE id=?').run(Math.round(Number(x.points)||0),Number(x.id)));
    if(Array.isArray(b.missions)) b.missions.forEach(x=>db.prepare('UPDATE missions SET points=? WHERE id=?').run(Math.round(Number(x.points)||0),Number(x.id)));
    if(Array.isArray(b.events)) b.events.forEach(x=>db.prepare('UPDATE events SET points=? WHERE id=?').run(Math.round(Number(x.points)||0),Number(x.id)));
    audit(u.id,'edit_scoring',null,JSON.stringify({target_points:target}));
    return json(res,200,{ok:true});
  }
  if(url==='/api/admin/bonus'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req),uid=Number(b.user_id),points=Math.round(Number(b.points));
    if(!db.prepare("SELECT id FROM users WHERE id=? AND role='candidate'").get(uid))return json(res,400,{error:'Кандидат не найден'});
    if(!Number.isFinite(points)||points===0||!clean(b.reason,500))return json(res,400,{error:'Укажите ненулевое количество баллов и причину'});
    const r=db.prepare('INSERT INTO bonus_points(user_id,points,reason,admin_id) VALUES(?,?,?,?)').run(uid,points,clean(b.reason,500),u.id);
    audit(u.id,'bonus_points',uid,JSON.stringify({points,reason:b.reason}));
    return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});
  }
  if(url.startsWith('/api/admin/bonus/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    if(!db.prepare('SELECT id FROM bonus_points WHERE id=?').get(id))return json(res,404,{error:'Баллы не найдены'});
    db.prepare('DELETE FROM bonus_points WHERE id=?').run(id); audit(u.id,'delete_bonus',null,JSON.stringify({bonus_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/dashboard'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    const stats={candidates:db.prepare("SELECT COUNT(*) n FROM users WHERE role='candidate'").get().n,admins:db.prepare("SELECT COUNT(*) n FROM users WHERE role IN ('admin','superadmin')").get().n,stamps:db.prepare('SELECT COUNT(*) n FROM stamps').get().n,missions:db.prepare('SELECT COUNT(*) n FROM mission_progress WHERE completed=1').get().n,events:db.prepare('SELECT COUNT(*) n FROM events').get().n,attendance:db.prepare("SELECT COUNT(*) n FROM event_attendance WHERE status='present'").get().n};
    return json(res,200,{stats});
  }
  if(url==='/api/admin/candidates'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const q=new URL(req.url,'http://x').searchParams.get('q')||'';
    const rows=db.prepare(`SELECT u.id,u.username,u.name,u.group_name,u.squad,u.phone,u.email,u.avatar,u.status,COUNT(s.id) stamps FROM users u LEFT JOIN stamps s ON s.user_id=u.id WHERE u.role='candidate' AND (u.name LIKE ? OR u.username LIKE ? OR u.group_name LIKE ? OR u.squad LIKE ?) GROUP BY u.id ORDER BY u.name`).all(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);
    return json(res,200,{candidates:rows.map(x=>({...x,score:scoreView(x.id)}))});
  }
  if(url.startsWith('/api/admin/candidate/')&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),v=userView(id); if(!v)return json(res,404,{error:'Пользователь не найден'}); return json(res,200,{candidate:v});
  }
  if(url.startsWith('/api/admin/candidate/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    const target=db.prepare("SELECT id,role FROM users WHERE id=?").get(id);
    if(!target||target.role!=='candidate')return json(res,404,{error:'Кандидат не найден'});
    db.prepare('DELETE FROM users WHERE id=?').run(id); audit(u.id,'delete_candidate',id,''); return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/user/')&&req.method==='PUT'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),target=db.prepare('SELECT * FROM users WHERE id=?').get(id); if(!target)return json(res,404,{error:'Пользователь не найден'});
    const b=await body(req); if(!clean(b.name,120))return json(res,400,{error:'Имя не может быть пустым'}); if(!validImage(b.avatar))return json(res,400,{error:'Фото имеет неверный формат или слишком большое'});
    const nextRole=['candidate','admin','superadmin'].includes(b.role)?b.role:target.role;
    if(target.role==='superadmin' && u.id!==target.id)return json(res,403,{error:'Главного администратора нельзя редактировать другим пользователям'});
    if(nextRole!==target.role && u.role!=='superadmin')return json(res,403,{error:'Только главный администратор может менять роли'});
    if(nextRole==='superadmin' && u.role!=='superadmin')return json(res,403,{error:'Недостаточно прав'});
    if(b.password && String(b.password).length<8)return json(res,400,{error:'Новый пароль должен быть не короче 8 символов'});
    const passwordPart=b.password ? ',password_hash=?' : '';
    const nextStatus=['active','blocked'].includes(b.status)?b.status:target.status;
    const params=[clean(b.name,120),clean(b.group_name,120),clean(b.squad,120),clean(b.phone,80),clean(b.email,160),b.avatar||'',nextRole,nextStatus,id];
    if(b.password) params.splice(6,0,hashPassword(String(b.password)));
    db.prepare(`UPDATE users SET name=?,group_name=?,squad=?,phone=?,email=?,avatar=?${passwordPart},role=?,status=? WHERE id=?`).run(...params);
    audit(u.id,'edit_user',id,JSON.stringify({role:nextRole,password_changed:Boolean(b.password)}));
    return json(res,200,{ok:true});
  }
  if(url==='/api/admin/stamp'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req),uid=Number(b.user_id),sid=Number(b.stage_id); const target=db.prepare('SELECT id,role FROM users WHERE id=?').get(uid);
    if(!target||target.role!=='candidate')return json(res,400,{error:'Некорректный кандидат'}); if(!db.prepare('SELECT id FROM stages WHERE id=?').get(sid))return json(res,400,{error:'Некорректный этап'});
    db.prepare(`INSERT INTO stamps(user_id,stage_id,admin_id,note) VALUES(?,?,?,?) ON CONFLICT(user_id,stage_id) DO UPDATE SET admin_id=excluded.admin_id,note=excluded.note,created_at=CURRENT_TIMESTAMP`).run(uid,sid,u.id,clean(b.note,1000));
    audit(u.id,'stamp',uid,JSON.stringify({stage_id:sid,note:b.note||''})); return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/stamp/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    if(!db.prepare('SELECT id FROM stamps WHERE id=?').get(id))return json(res,404,{error:'Штамп участника не найден'});
    db.prepare('DELETE FROM stamps WHERE id=?').run(id); audit(u.id,'delete_stamp',null,JSON.stringify({stamp_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/stages'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req);
    if(!clean(b.title,120)||!clean(b.subtitle,240))return json(res,400,{error:'Название и описание обязательны'});
    if(String(b.icon||'').startsWith('data:image/') && !validImage(b.icon))return json(res,400,{error:'Иконка имеет неверный формат или слишком большая'});
    const r=db.prepare('INSERT INTO stages(title,subtitle,icon,accent,sort_order,points) VALUES(?,?,?,?,?,?)').run(clean(b.title,120),clean(b.subtitle,240),String(b.icon||'✦'),clean(b.accent,30)||'#173f34',Number(b.sort_order)||99,Math.max(0,Math.round(Number(b.points)||10)));
    audit(u.id,'create_stamp_definition',null,JSON.stringify({stage_id:Number(r.lastInsertRowid)})); return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});
  }
  if(url.startsWith('/api/admin/stages/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    if(!db.prepare('SELECT id FROM stages WHERE id=?').get(id))return json(res,404,{error:'Штамп не найден'});
    db.prepare('DELETE FROM stamps WHERE stage_id=?').run(id);
    db.prepare('DELETE FROM missions WHERE stage_id=?').run(id);
    db.prepare('UPDATE events SET stage_id=NULL WHERE stage_id=?').run(id);
    db.prepare('DELETE FROM stages WHERE id=?').run(id); audit(u.id,'delete_stamp_definition',null,JSON.stringify({stage_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/stages'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    return json(res,200,{stages:db.prepare('SELECT * FROM stages ORDER BY sort_order').all()});
  }
  if(url.startsWith('/api/admin/stages/')&&req.method==='PATCH'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    const id=Number(url.split('/').pop()),old=db.prepare('SELECT * FROM stages WHERE id=?').get(id); if(!old)return json(res,404,{error:'Штамп не найден'});
    const b=await body(req); if(!clean(b.title,120)||!clean(b.subtitle,240))return json(res,400,{error:'Название и описание обязательны'});
    const iconValue=String(b.icon??'').trim();
    if(iconValue && iconValue.startsWith('data:image/') && !validImage(iconValue))return json(res,400,{error:'Иконка должна быть корректным PNG, JPG или WebP'});
    if(iconValue.length>2_500_000)return json(res,400,{error:'Файл иконки слишком большой'});
    const icon=iconValue||old.icon;
    db.prepare('UPDATE stages SET title=?,subtitle=?,icon=?,accent=?,sort_order=?,points=? WHERE id=?').run(clean(b.title,120),clean(b.subtitle,240),icon,clean(b.accent,30)||old.accent,Number(b.sort_order)||old.sort_order,Math.max(0,Math.round(Number(b.points) || old.points || 10)),id);
    audit(u.id,'edit_stamp_definition',null,JSON.stringify({stage_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/stamp/edit'&&req.method==='PATCH'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    const b=await body(req),id=Number(b.id),old=db.prepare('SELECT * FROM stamps WHERE id=?').get(id); if(!old)return json(res,404,{error:'Штамп участника не найден'});
    const sid=Number(b.stage_id||old.stage_id); if(!db.prepare('SELECT id FROM stages WHERE id=?').get(sid))return json(res,400,{error:'Некорректный этап'});
    db.prepare('UPDATE stamps SET stage_id=?,note=? WHERE id=?').run(sid,clean(b.note,1000),id); audit(u.id,'edit_stamp',old.user_id,JSON.stringify({stamp_id:id,stage_id:sid})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/missions'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    return json(res,200,{missions:db.prepare('SELECT m.*,s.title stage_title FROM missions m JOIN stages s ON s.id=m.stage_id ORDER BY m.sort_order,m.id').all()});
  }
  if(url==='/api/admin/missions'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req);
    if(!clean(b.title,200)||!clean(b.description,3000)||!b.stage_id||!b.date_from||!b.date_to)return json(res,400,{error:'Заполните название, описание, этап и даты'});
    const r=db.prepare('INSERT INTO missions(stage_id,title,description,date_from,date_to,sort_order,points) VALUES(?,?,?,?,?,?,?)').run(Number(b.stage_id),clean(b.title,200),clean(b.description,3000),clean(b.date_from,20),clean(b.date_to,20),Number(b.sort_order)||0,Math.max(0,Math.round(Number(b.points)||5)));
    audit(u.id,'create_mission',null,JSON.stringify({mission_id:Number(r.lastInsertRowid)})); return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});
  }
  if(url.startsWith('/api/admin/missions/')&&req.method==='PATCH'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),old=db.prepare('SELECT * FROM missions WHERE id=?').get(id); if(!old)return json(res,404,{error:'Миссия не найдена'}); const b=await body(req);
    db.prepare('UPDATE missions SET stage_id=?,title=?,description=?,date_from=?,date_to=?,sort_order=?,points=? WHERE id=?').run(Number(b.stage_id||old.stage_id),clean(b.title,200)||old.title,clean(b.description,3000)||old.description,clean(b.date_from,20)||old.date_from,clean(b.date_to,20)||old.date_to,Number(b.sort_order)||old.sort_order,Math.max(0,Math.round(Number(b.points)||old.points||5)),id);
    audit(u.id,'edit_mission',null,JSON.stringify({mission_id:id})); return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/missions/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()); if(!db.prepare('SELECT id FROM missions WHERE id=?').get(id))return json(res,404,{error:'Миссия не найдена'}); db.prepare('DELETE FROM missions WHERE id=?').run(id); audit(u.id,'delete_mission',null,JSON.stringify({mission_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/users'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; return json(res,200,{admins:db.prepare(`SELECT id,username,name,role,group_name,squad,phone,email,avatar,status,created_at FROM users WHERE role IN ('admin','superadmin') ORDER BY role DESC,name`).all()});
  }
  if(url==='/api/admin/users'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req),role=['admin','candidate'].includes(b.role)?b.role:null;
    if(!role||!b.username||!b.password||!b.name)return json(res,400,{error:'Заполните обязательные поля'}); if(!validImage(b.avatar))return json(res,400,{error:'Фото имеет неверный формат или слишком большое'});
    try{const r=db.prepare('INSERT INTO users(username,password_hash,role,name,group_name,squad,phone,email,avatar) VALUES(?,?,?,?,?,?,?,?,?)').run(clean(b.username,100),hashPassword(String(b.password)),role,clean(b.name,120),clean(b.group_name,120),clean(b.squad,120),clean(b.phone,80),clean(b.email,160),b.avatar||''); audit(u.id,'create_user',Number(r.lastInsertRowid),JSON.stringify({role})); return json(res,201,{ok:true,id:Number(r.lastInsertRowid)})}catch(e){return json(res,400,{error:'Такой логин уже существует'})}
  }
  if(url.startsWith('/api/admin/promote/')&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),target=db.prepare('SELECT id,role FROM users WHERE id=?').get(id); if(!target)return json(res,404,{error:'Пользователь не найден'});
    if(target.role==='superadmin')return json(res,403,{error:'Главного администратора нельзя изменить через эту панель'}); if(u.role!=='superadmin'&&target.role==='admin')return json(res,403,{error:'Только главный администратор может менять права администратора'});
    const b=await body(req),role=b.role==='admin'?'admin':'candidate'; db.prepare('UPDATE users SET role=? WHERE id=?').run(role,id); audit(u.id,'change_role',id,JSON.stringify({role})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/categories'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return;
    return json(res,200,{categories:db.prepare('SELECT * FROM event_categories ORDER BY sort_order,name').all()});
  }
  if(url==='/api/admin/categories'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req);
    if(!clean(b.name,120))return json(res,400,{error:'Название категории обязательно'});
    try{const r=db.prepare('INSERT INTO event_categories(name,description,sort_order) VALUES(?,?,?)').run(clean(b.name,120),clean(b.description,500),Number(b.sort_order)||0);audit(u.id,'create_event_category',null,JSON.stringify({category_id:Number(r.lastInsertRowid)}));return json(res,201,{ok:true,id:Number(r.lastInsertRowid)})}catch(e){return json(res,400,{error:'Такая категория уже существует'})}
  }
  if(url.startsWith('/api/admin/categories/')&&req.method==='PUT'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),b=await body(req);
    if(!db.prepare('SELECT id FROM event_categories WHERE id=?').get(id))return json(res,404,{error:'Категория не найдена'});
    db.prepare('UPDATE event_categories SET name=?,description=?,sort_order=?,active=? WHERE id=?').run(clean(b.name,120),clean(b.description,500),Number(b.sort_order)||0,b.active===false?0:1,id);audit(u.id,'edit_event_category',null,JSON.stringify({category_id:id}));return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/categories/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    if(!db.prepare('SELECT id FROM event_categories WHERE id=?').get(id))return json(res,404,{error:'Категория не найдена'});
    db.prepare('UPDATE events SET category_id=NULL WHERE category_id=?').run(id);db.prepare('DELETE FROM event_categories WHERE id=?').run(id);audit(u.id,'delete_event_category',null,JSON.stringify({category_id:id}));return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/event/')&&url.endsWith('/attendance')&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/')[4]);
    const rows=db.prepare(`SELECT u.id,u.name,u.squad,u.group_name,u.avatar,COALESCE(ea.status,'absent') attendance_status,ea.points_override,ea.note
      FROM users u LEFT JOIN event_attendance ea ON ea.user_id=u.id AND ea.event_id=? WHERE u.role='candidate' ORDER BY u.name`).all(id);
    return json(res,200,{participants:rows});
  }
  if(url.startsWith('/api/admin/event/')&&url.endsWith('/attendance')&&req.method==='PUT'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/')[4]),b=await body(req);
    const uid=Number(b.user_id); const status=['present','absent','excused'].includes(b.status)?b.status:'absent';
    if(!db.prepare('SELECT id FROM events WHERE id=?').get(id)||!db.prepare("SELECT id FROM users WHERE id=? AND role='candidate'").get(uid))return json(res,400,{error:'Некорректное мероприятие или участник'});
    db.prepare(`INSERT INTO event_attendance(event_id,user_id,status,points_override,note,marked_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status,points_override=excluded.points_override,note=excluded.note,marked_by=excluded.marked_by,marked_at=CURRENT_TIMESTAMP`)
      .run(id,uid,status,b.points_override===null||b.points_override===''?null:Math.round(Number(b.points_override)),clean(b.note,500),u.id);
    audit(u.id,'attendance',uid,JSON.stringify({event_id:id,status}));return json(res,200,{ok:true});
  }
  if(url.startsWith('/api/admin/event/')&&req.method==='DELETE'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop());
    if(!db.prepare('SELECT id FROM events WHERE id=?').get(id))return json(res,404,{error:'Событие не найдено'});
    db.prepare('DELETE FROM events WHERE id=?').run(id);audit(u.id,'delete_event',null,JSON.stringify({event_id:id}));return json(res,200,{ok:true});
  }
  if(url==='/api/admin/events'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const rows=db.prepare(`SELECT e.*,st.title stage_title,ec.name category_name,(SELECT COUNT(*) FROM event_registrations r WHERE r.event_id=e.id) registrations,(SELECT COUNT(*) FROM event_attendance a WHERE a.event_id=e.id AND a.status='present') attendance_count FROM events e LEFT JOIN stages st ON st.id=e.stage_id LEFT JOIN event_categories ec ON ec.id=e.category_id ORDER BY e.event_date,e.time_start`).all(); return json(res,200,{events:rows});
  }
  if(url.startsWith('/api/admin/event/')&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),e=eventView(id); if(!e)return json(res,404,{error:'Событие не найдено'}); return json(res,200,{event:e});
  }
  if(url==='/api/admin/events'&&req.method==='POST'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const b=await body(req); if(!b.title||!b.event_date)return json(res,400,{error:'Название и дата обязательны'});
    const r=db.prepare('INSERT INTO events(title,stage_id,event_date,time_start,time_end,location,description,program,organizer,contact,materials,type,sort_order,points,visibility,audience,target_squad,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(clean(b.title,200),Number(b.stage_id)||null,clean(b.event_date,20),clean(b.time_start,10),clean(b.time_end,10),clean(b.location,200),clean(b.description,3000),clean(b.program,5000),clean(b.organizer,200),clean(b.contact,500),clean(b.materials,2000),clean(b.type,80)||'ШМБ',Number(b.sort_order)||0,Math.max(0,Math.round(Number(b.points)||3)),['open','closed'].includes(b.visibility)?b.visibility:'open',['all','squad'].includes(b.audience)?b.audience:'all',clean(b.target_squad,120),Number(b.category_id)||null);
    audit(u.id,'create_event',null,JSON.stringify({event_id:Number(r.lastInsertRowid)})); return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});
  }
  if(url.startsWith('/api/admin/event/')&&req.method==='PUT'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; const id=Number(url.split('/').pop()),old=db.prepare('SELECT * FROM events WHERE id=?').get(id); if(!old)return json(res,404,{error:'Событие не найдено'}); const b=await body(req); if(!b.title||!b.event_date)return json(res,400,{error:'Название и дата обязательны'});
    db.prepare('UPDATE events SET title=?,stage_id=?,event_date=?,time_start=?,time_end=?,location=?,description=?,program=?,organizer=?,contact=?,materials=?,type=?,sort_order=?,points=?,visibility=?,audience=?,target_squad=?,category_id=? WHERE id=?').run(clean(b.title,200),Number(b.stage_id)||null,clean(b.event_date,20),clean(b.time_start,10),clean(b.time_end,10),clean(b.location,200),clean(b.description,3000),clean(b.program,5000),clean(b.organizer,200),clean(b.contact,500),clean(b.materials,2000),clean(b.type,80)||'ШМБ',Number(b.sort_order)||0,Math.max(0,Math.round(Number(b.points)||old?.points||3)),['open','closed'].includes(b.visibility)?b.visibility:(old?.visibility||'open'),['all','squad'].includes(b.audience)?b.audience:(old?.audience||'all'),clean(b.target_squad,120),Number(b.category_id)||null,id);
    audit(u.id,'edit_event',null,JSON.stringify({event_id:id})); return json(res,200,{ok:true});
  }
  if(url==='/api/admin/audit'&&req.method==='GET'){
    const u=requireAuth(req,res,['superadmin','admin']); if(!u)return; return json(res,200,{logs:db.prepare(`SELECT l.*,a.name admin_name,t.name target_name FROM audit_log l JOIN users a ON a.id=l.admin_id LEFT JOIN users t ON t.id=l.target_user_id ORDER BY l.id DESC LIMIT 150`).all()});
  }
  return json(res,404,{error:'Not found'});
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`).pathname;
  try{
    if(url.startsWith('/api/')) return await api(req,res,url);
    if(url.startsWith('/profile/')){
      const id=Number(url.split('/').pop()),v=userView(id); if(!v)return send(res,404,'Профиль не найден'); const pct=Number(v.score?.progress||0);
      const escHtml=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const iconHtml=s=>String(s||'✦').startsWith('data:image/')?`<img src="${escHtml(s)}" class="stage-icon-img" alt="">`:escHtml(s||'✦');
      return send(res,200,`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Профиль ${escHtml(v.name)}</title><style>body{margin:0;background:#0d1714;color:#fff;font-family:system-ui;padding:28px}.card{max-width:560px;margin:30px auto;background:#fffaf0;color:#173f34;border-radius:24px;padding:28px}.mark{font-weight:900;letter-spacing:.08em}.public-logo{width:220px;max-width:100%;height:auto;margin-bottom:20px}.tag{display:inline-block;background:#e4eee3;padding:6px 9px;border-radius:99px;font-size:11px;font-weight:800;margin-top:20px}.photo{width:84px;height:84px;border-radius:50%;object-fit:cover;background:#dbe6da;display:block;margin-top:20px}h1{font-size:42px;line-height:1;margin:12px 0}.muted{color:#718078}.bar{height:10px;background:#ded9ca;border-radius:10px;overflow:hidden}.bar i{display:block;height:100%;width:${pct}%;background:#f2c51b}.stamps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:20px}.s{padding:14px 8px;border-radius:14px;background:#edf5ed;text-align:center;font-size:12px}.s.off{opacity:.45;background:#f0ede4}@media(max-width:500px){h1{font-size:34px}.stamps{grid-template-columns:repeat(2,1fr)}}</style><body><main class="card"><img class="public-logo" src="/logo-rosbiotech.svg" alt="РОСБИОТЕХ">${v.avatar?`<img class="photo" src="${v.avatar}" alt="Фото ${escHtml(v.name)}">`:''}<span class="tag">ЦИФРОВОЙ ПРОФИЛЬ КАНДИДАТА</span><h1>${escHtml(v.name)}</h1><p class="muted">${escHtml(v.group_name||'')} ${v.squad?'· '+escHtml(v.squad):''}</p><p><b>Прогресс ШМБ</b> · ${v.score?.total||0}/${v.score?.target||100} баллов</p><div class="bar"><i></i></div><div class="stamps">${Array.from({length:6},(_,i)=>{const s=v.stamps.find(s=>s.stage_id===i+1);return `<div class="s ${s?'':'off'}">${s?iconHtml(s.icon):'✦'}<br><b>${s?s.title:'Этап '+(i+1)}</b><br>${s?'пройдено':'ожидает'}</div>`}).join('')}</div></main></body></html>`,{'Content-Type':'text/html; charset=utf-8'});
    }
    const file=url==='/'?'/index.html':url; const fp=path.normalize(path.join(PUBLIC,file)); if(!fp.startsWith(PUBLIC))return send(res,403,'Forbidden'); if(fs.existsSync(fp)&&fs.statSync(fp).isFile())return send(res,200,fs.readFileSync(fp),{'Content-Type':mime[path.extname(fp)]||'application/octet-stream'}); return send(res,404,'Not found');
  }catch(e){console.error(e);return json(res,500,{error:'Ошибка сервера'});}
});
server.listen(PORT,()=>console.log(`SMB Passport running at http://localhost:${PORT}`));

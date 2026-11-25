import * as L from './logic.js';
import { T } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('md.' + k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem('md.' + k, JSON.stringify(v)), del: (k) => localStorage.removeItem('md.' + k) };

const S = {
  lang: new URLSearchParams(location.search).get('lang') || LS.get('lang', 'en'), token: LS.get('token', null), me: LS.get('me', null),
  data: null, modal: null, busy: false, child: null, term: 1, q: '', classF: '', overdueOnly: false, rcptQ: '',
  att: null, gr: null, tt: null, annAud: 'all', err: '',
};
if (!T[S.lang]) S.lang = 'en';
const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
const t = (k) => get(T[S.lang], k) ?? get(T.en, k) ?? k;
const ar = () => S.lang === 'ar';
const nf = (n, d = 0) => Number(n).toLocaleString(ar() ? 'ar-EG' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (c) => `${nf(c / 100, 2)} ${t('cur')}`;
const dt = (k) => (k ? new Date(k + 'T00:00:00Z').toLocaleDateString(ar() ? 'ar-EG' : 'en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const dts = (ts) => dt(L.dayKey(ts));
const tm = (ts) => new Date(ts).toLocaleTimeString(ar() ? 'ar-EG' : 'en-GB', { timeZone: L.TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const nm = (o) => (ar() ? o.nameAr || o.name : o.name);
const D = () => S.data;
const me = () => S.data?.me || S.me;
const role = () => me()?.role;
const classes = () => D().allClasses || D().classes;
const clsOf = (id) => classes().find((c) => c.id === id) || D().classes.find((c) => c.id === id);
const stOf = (id) => D().students.find((s) => s.id === id);
const subOf = (id) => D().subjects.find((s) => s.id === id);
const teacherOf = (id) => D().teachers.find((x) => x.id === id) || { name: '?', nameAr: '?' };
const tx = (o, f) => (ar() ? o[f + 'Ar'] || o[f] : o[f]);
const toast = (m, bad) => { const el = $('#toast'); el.innerHTML = `<div class="${bad ? 'err' : ''}">${esc(m)}</div>`; clearTimeout(toast.h); toast.h = setTimeout(() => (el.innerHTML = ''), bad ? 5500 : 2600); };
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const toCents = (s) => { const n = parseFloat(String(s ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };

// ---------- network ----------
class NetError extends Error {}
async function call(method, body) {
  let r;
  try { r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); } catch { throw new NetError('offline'); }
  let j = {}; try { j = await r.json(); } catch { if (r.status >= 500) throw new NetError('server'); }
  if (r.status === 401 && S.token) { logout(true); throw new Error(j.error || t('again')); }
  if (r.status >= 500) throw new NetError('server');
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
async function act(op, okMsg) {
  if (S.busy) return null; S.busy = true;
  try { const j = await call('POST', { op }); const { result, ...v } = j; S.data = v; if (okMsg) toast(okMsg); return result || {}; }
  catch (e) { toast(e instanceof NetError ? t(e.message === 'offline' ? 'offline' : 'err.server') : e.message, true); return null; }
  finally { S.busy = false; }
}
async function refresh() { try { S.data = await call('GET'); S.err = ''; } catch (e) { S.err = e instanceof NetError ? t('offline') : e.message; } }
async function login(pin) {
  try { const j = await call('POST', { op: { type: 'login', pin } }); S.token = j.token; S.me = j.me; LS.set('token', j.token); LS.set('me', j.me); await refresh(); location.hash = '#/dashboard'; S.att = S.gr = S.tt = null; S.child = null; render(); }
  catch (e) { S.err = e.message; render(); }
}
function logout() { S.token = null; S.me = null; S.data = null; LS.del('token'); LS.del('me'); S.modal = null; location.hash = ''; render(); }

// ---------- routing ----------
const route = () => { const [p, a, b] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/'); return { p, a, b }; };
const NAV = {
  admin: ['dashboard', 'students', 'attendance', 'grades', 'fees', 'receipts', 'overdue', 'timetable', 'announcements', 'people', 'audit'],
  teacher: ['dashboard', 'attendance', 'grades', 'students', 'timetable', 'announcements'],
  accountant: ['dashboard', 'fees', 'receipts', 'overdue', 'announcements'],
  parent: ['dashboard', 'progress', 'fees', 'timetable', 'announcements'],
};

// ---------- small views ----------
const pill = (cls, txt) => `<span class="pill ${cls}">${esc(txt)}</span>`;
const empty = (m) => `<p class="empty">${esc(m || t('none'))}</p>`;
const bar = (pct, cls = '') => `<div class="meter ${cls}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
const kpi = (n, l, cls = '') => `<div class="card kpi ${cls}"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
const rateCls = (r) => (r == null ? 'gray' : r >= 92 ? '' : r >= 85 ? 'off' : 'bad');
const classLabel = (c) => nm(c);
function chart(series) {
  const max = Math.max(1, ...series.map((x) => x.amount));
  return `<div class="charts" role="img" aria-label="${esc(t('collections14'))}">${series.map((x) => `<div class="col" title="${esc(dt(x.day) + ': ' + money(x.amount))}"><div class="b" style="height:${Math.round((x.amount / max) * 100)}%"></div><small>${nf(Number(x.day.slice(8)))}</small></div>`).join('')}</div>`;
}
function annList(list, max = 99) {
  if (!list.length) return empty();
  return list.slice(0, max).map((a) => `<article class="ann ${a.system ? 'sys' : ''}"><div class="ann-h"><b>${esc(tx(a, 'title'))}</b>${a.pinned ? ' ' + pill('off', t('pinned')) : ''}${pill(a.audience === 'all' ? 'gray' : a.audience.startsWith('user:') ? 'bad' : 'ok', a.audience.startsWith('user:') ? t('toYou') : a.audience === 'all' ? t('forAll') : a.audience === 'parents' ? t('forParents') : a.audience === 'teachers' ? t('forTeachers') : (clsOf(a.audience.slice(6)) ? classLabel(clsOf(a.audience.slice(6))) : t('forAll')))}</div><p>${esc(tx(a, 'body'))}</p><small>${esc(a.byName)} · ${esc(dts(a.at))}</small>${canDeleteAnn(a) ? `<button class="btn sm danger" data-act="del-ann" data-id="${esc(a.id)}">${esc(t('delete'))}</button>` : ''}</article>`).join('');
}
const canDeleteAnn = (a) => role() === 'admin' || (role() === 'teacher' && a.by === me().id);

// ---------- pages ----------
function login_() {
  return `<div class="login"><div class="logo">${LOGO}<div><h1>${esc(t('appName'))}</h1><p class="sub">${esc(t('appSub'))}</p></div><button class="btn sm" data-act="lang" style="margin-inline-start:auto">${esc(t('other'))}</button></div>
  <div class="card"><h2>${esc(t('signin'))}</h2><p class="muted">${esc(t('demoNote'))}</p>
  <div class="demo-users">${L.DEMO_USERS.map((d) => `<button class="btn" data-act="demo" data-pin="${d.pin}"><span>${esc(ar() ? d.labelAr : d.label)}</span><span class="pill gray">${esc(t('role.' + d.role))} · ${d.pin}</span></button>`).join('')}</div>
  <form data-form="login" class="row"><input id="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${esc(t('pin'))}" aria-label="${esc(t('pin'))}"><button class="btn pri" type="submit">${esc(t('signin'))}</button></form>
  ${S.err ? `<p class="notice bad" role="alert">${esc(S.err)}</p>` : ''}</div><p class="muted small">${esc(t('limits'))}</p></div>`;
}
const LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#27406f"/><path d="M8 20 24 11l16 9-16 9z" fill="#f2b84b"/><path d="M14 26v8c0 3 5 6 10 6s10-3 10-6v-8l-10 5.5z" fill="#fff"/><rect x="38" y="20" width="2.4" height="12" rx="1.2" fill="#f2b84b"/></svg>';

function top() {
  const r = route(), items = NAV[role()];
  return `<header class="top"><a class="brand" href="#/dashboard">${LOGO}<span>${esc(t('appName'))}<small>${esc(nm(D().school))}</small></span></a>
  <nav class="nav" aria-label="Main">${items.map((k) => `<a href="#/${k}" class="${r.p === k || (k === 'students' && r.p === 'student') || (k === 'progress' && r.p === 'report') ? 'on' : ''}">${esc(t('nav.' + k))}</a>`).join('')}</nav>
  <div class="tools"><span class="who">${esc(nm(me()))} <span class="pill">${esc(t('role.' + role()))}</span></span><button class="btn ghost sm" data-act="lang">${esc(t('other'))}</button><button class="btn ghost sm" data-act="logout">${esc(t('logout'))}</button></div></header>`;
}

// ----- dashboard -----
function dashboard() {
  const r = role(); return r === 'admin' ? dashAdmin() : r === 'teacher' ? dashTeacher() : r === 'accountant' ? dashAccountant() : dashParent();
}
function attToday() {
  const d = D(), day = d.currentSchoolDay, rows = d.classes.map((c) => { const rec = d.attendance.find((x) => x.classId === c.id && x.date === day); const n = rec ? Object.keys(rec.marks).length : 0; const p = rec ? Object.values(rec.marks).filter((m) => m === 'P' || m === 'L').length : 0; return { c, rec, n, p }; });
  return { day, rows, taken: rows.filter((x) => x.rec).length, present: rows.reduce((s, x) => s + x.p, 0), total: rows.reduce((s, x) => s + x.n, 0) };
}
function financeCards(f) {
  return `<div class="grid kpis">${kpi(money(f.billed), t('billed'))}${kpi(money(f.collected), t('collected'), 'good')}${kpi(money(f.outstanding), t('outstanding'))}${kpi(money(f.overdue), t('overdue'), 'bad')}</div>`;
}
function financePanels(f, remind) {
  const ag = f.aging, tot = Math.max(1, ag.d30 + ag.d60 + ag.d61);
  return `<div class="grid two"><section class="card"><h2>${esc(t('collections14'))}</h2>${chart(f.series)}<p class="muted small">${esc(t('byMethod'))}: ${Object.entries(f.byMethod).map(([k, v]) => `${esc(t(k))} ${esc(money(v))}`).join(' · ')}</p></section>
  <section class="card"><h2>${esc(t('aging'))}</h2>${[['d30', ''], ['d60', 'off'], ['d61', 'bad']].map(([k, c]) => `<div class="agrow"><span>${esc(t(k))}</span>${bar((ag[k] / tot) * 100, c)}<b>${esc(money(ag[k]))}</b></div>`).join('')}<p class="muted small">${esc(t('upcoming30'))}: <b>${esc(money(f.upcoming30))}</b></p></section></div>
  ${remind ? `<section class="card"><h2>${esc(t('overdue'))}</h2>${overdueTable(f.overdueStudents.slice(0, 6))}<p><a href="#/overdue">${esc(t('nav.overdue'))} →</a></p></section>` : ''}`;
}
function dashAdmin() {
  const d = D(), a = attToday(), f = d.finance, active = d.students.filter((s) => s.status === 'active').length;
  return `<h1>${esc(t('nav.dashboard'))}</h1>${d.schoolDay ? '' : `<p class="notice">${esc(t('weekend'))}</p>`}
  <div class="grid kpis">${kpi(nf(active), t('kpiStudents'))}${kpi(a.total ? nf(Math.round((a.present / a.total) * 100)) + '%' : '-', `${t('classesToday')} · ${a.taken}/${d.classes.length} ${t('markedClasses')}`)}${kpi(money(f.collected), t('collected'), 'good')}${kpi(money(f.overdue), t('overdue'), 'bad')}</div>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('byClass'))} · ${esc(dt(a.day))}</h2><div class="tw"><table><thead><tr><th>${esc(t('class'))}</th><th>${esc(t('teacherLabel'))}</th><th class="num">${esc(t('presentToday'))}</th><th class="num">${esc(t('capacityUsed'))}</th></tr></thead><tbody>${a.rows.map((x) => `<tr><td>${esc(classLabel(x.c))}</td><td>${esc(nm(teacherOf(x.c.teacher)))}</td><td class="num">${x.rec ? `${nf(x.p)} / ${nf(x.n)}` : pill('off', t('notYet'))}</td><td class="num">${nf(x.c.count)} / ${nf(x.c.capacity)}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="card"><h2>${esc(t('nav.announcements'))}</h2>${annList(d.announcements, 3)}<p><a href="#/announcements">${esc(t('nav.announcements'))} →</a></p></section></div>
  <div style="margin-top:1rem">${financePanels(f, true)}</div>
  <p class="foot"><button class="btn sm" data-act="reset">${esc(t('resetDemo'))}</button></p>`;
}
function dashAccountant() {
  const f = D().finance; return `<h1>${esc(t('nav.dashboard'))}</h1>${financeCards(f)}<div style="margin-top:1rem">${financePanels(f, true)}</div>`;
}
function dashTeacher() {
  const d = D(), a = attToday(), home = d.classes.filter((c) => c.teacher === me().id), todayDow = L.dow(L.dayKey(d.now));
  const mine = d.slots.filter((x) => x.teacherId === me().id && x.day === (L.isSchoolDay(d.today) ? todayDow : -1)).sort((x, y) => x.period - y.period);
  const pending = (d.gradeable || []).map((g) => { const kids = d.students.filter((s) => s.classId === g.classId); let miss = 0; for (const k of kids) for (const kind of Object.keys(L.KINDS)) if (!d.scores[L.scoreKey(k.id, g.subjectId, 1, kind)]) miss++; return { g, miss, n: kids.length * 3 }; }).filter((x) => x.miss);
  return `<h1>${esc(t('welcomeBack'))} ${esc(nm(me()))}</h1>${d.schoolDay ? '' : `<p class="notice">${esc(t('weekend'))}</p>`}
  <div class="grid two">${home.map((c) => { const x = a.rows.find((r) => r.c.id === c.id); return `<section class="card"><h2>${esc(t('myClass'))}: ${esc(classLabel(c))}</h2><p>${nf(c.count)} ${esc(t('studentsInClass'))} · ${esc(t('room'))} ${esc(c.room)}</p><p>${x?.rec ? pill('', `${t('taken')} · ${dt(a.day)}`) : pill('off', `${t('notTaken')} · ${dt(a.day)}`)}</p><a class="btn pri" href="#/attendance">${esc(t('takeAtt'))}</a></section>`; }).join('')}
  <section class="card"><h2>${esc(t('todayTimetable'))}</h2>${mine.length ? `<table><tbody>${mine.map((x) => `<tr><td>${esc(t('times')[x.period - 1])}</td><td>${esc(nm(subOf(x.subjectId)))}</td><td>${esc(classLabel(clsOf(x.classId)))}</td></tr>`).join('')}</tbody></table>` : empty(t('noPeriods'))}</section></div>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('gradeEntry'))} · ${esc(t('term1'))}</h2>${(d.gradeable || []).length ? `<table><tbody>${(d.gradeable).map((g) => { const kids = d.students.filter((s) => s.classId === g.classId); let miss = 0; for (const k of kids) for (const kind of Object.keys(L.KINDS)) if (!d.scores[L.scoreKey(k.id, g.subjectId, 1, kind)]) miss++; return `<tr><td>${esc(classLabel(clsOf(g.classId)))}</td><td>${esc(nm(subOf(g.subjectId)))}</td><td class="num">${miss ? pill('off', `${t('missingMarks')}: ${nf(miss)}`) : pill('', t('complete'))}</td></tr>`; }).join('')}</tbody></table>` : empty()}<p><a href="#/grades">${esc(t('nav.grades'))} →</a></p><span hidden>${pending.length}</span></section>
  <section class="card"><h2>${esc(t('nav.announcements'))}</h2>${annList(d.announcements, 3)}</section></div>`;
}
function dashParent() {
  const d = D(), kids = d.students, notices = d.announcements.filter((a) => a.audience.startsWith('user:'));
  return `<h1>${esc(t('myChildren'))}</h1>${notices.length ? `<section class="card notice bad"><h2>${esc(t('notices'))}</h2>${annList(notices, 2)}</section>` : ''}
  <div class="grid two">${kids.map((s) => { const c = clsOf(s.classId), att = L.attendanceStats(d.attendance, s.id), rc = L.reportCard(d, s.id, 1);
    return `<section class="card child"><h2>${esc(nm(s))}</h2><p class="muted">${esc(classLabel(c))} · ${esc(t('code'))} ${esc(s.code)}</p>
    <div class="grid kpis small">${kpi(att.rate == null ? '-' : nf(att.rate) + '%', t('attRate'), rateCls(att.rate) === 'bad' ? 'bad' : '')}${kpi(rc.average == null ? '-' : `${nf(rc.average, 1)} ${rc.letter}`, `${t('latest')} · ${t('term1')}`)}${kpi(s.fin.balance ? money(s.fin.balance) : t('nothingDue'), t('balanceDue'), s.fin.overdue ? 'bad' : '')}</div>
    ${s.fin.overdue ? `<p class="notice bad">${esc(t('overdue'))}: ${esc(money(s.fin.overdue))}</p>` : s.fin.next ? `<p class="muted">${esc(t('nextDue'))}: ${esc(tx(s.fin.next, 'label'))} · ${esc(dt(s.fin.next.due))} · ${esc(money(s.fin.next.amount))}</p>` : ''}
    <a class="btn" href="#/report/${esc(s.id)}/1">${esc(t('reportCard'))}</a> <a class="btn" href="#/fees">${esc(t('nav.fees'))}</a></section>`; }).join('')}</div>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('nav.announcements'))}</h2>${annList(d.announcements.filter((a) => !a.audience.startsWith('user:')), 3)}</section>`;
}

// ----- students -----
function students() {
  const d = D(), q = S.q.toLowerCase(), r = role();
  const list = d.students.filter((s) => (!S.classF || s.classId === S.classF) && (!q || s.name.toLowerCase().includes(q) || (s.nameAr || '').includes(S.q) || s.code.toLowerCase().includes(q)));
  const money_ = r === 'admin' || r === 'accountant';
  return `<h1>${esc(t('students'))}</h1><div class="bar"><input id="q" data-in="q" value="${esc(S.q)}" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}"><select data-in="classF" aria-label="${esc(t('class'))}"><option value="">${esc(t('allClasses'))}</option>${classes().map((c) => `<option value="${c.id}" ${S.classF === c.id ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select><span class="sp"></span>${r === 'admin' ? `<button class="btn pri" data-act="add-student">${esc(t('addStudent'))}</button>` : ''}</div>
  <div class="tw"><table><thead><tr><th>${esc(t('code'))}</th><th>${esc(t('name'))}</th><th>${esc(t('class'))}</th><th>${esc(t('guardian'))}</th>${money_ ? `<th class="num">${esc(t('balance'))}</th>` : ''}<th>${esc(t('status'))}</th><th></th></tr></thead><tbody>${list.map((s) => `<tr><td>${esc(s.code)}</td><td>${esc(nm(s))}</td><td>${esc(classLabel(clsOf(s.classId)))}</td><td>${s.guardian ? `${esc(nm(s.guardian))}<br><small class="muted" dir="ltr">${esc(s.guardian.phone)}</small>` : ''}</td>${money_ ? `<td class="num">${s.fin.overdue ? pill('bad', money(s.fin.overdue)) : s.fin.balance ? esc(money(s.fin.balance)) : s.fin.hasPlan ? pill('', t('paidFull')) : pill('gray', t('noPlan'))}</td>` : ''}<td>${s.status === 'active' ? pill('', t('active')) : pill('gray', t('withdrawn'))}</td><td><a class="btn sm" href="#/student/${esc(s.id)}">${esc(t('view'))}</a></td></tr>`).join('')}</tbody></table></div>${list.length ? '' : empty()}`;
}
function studentPage(id) {
  const d = D(), s = stOf(id); if (!s) return `<p>${esc(t('none'))}</p>`;
  const r = role(), c = clsOf(s.classId), att = d.attendance ? L.attendanceStats(d.attendance, s.id) : null;
  return `<p><a class="text-link" href="#/students">← ${esc(t('back'))}</a></p><div class="bar"><h1>${esc(nm(s))}</h1><span class="sp"></span>${s.status === 'active' ? pill('', t('active')) : pill('gray', t('withdrawn'))}</div>
  <div class="grid two"><section class="card"><dl class="dl"><dt>${esc(t('code'))}</dt><dd>${esc(s.code)}</dd><dt>${esc(t('class'))}</dt><dd>${esc(classLabel(c))}</dd><dt>${esc(t('dob'))}</dt><dd>${esc(dt(s.dob))}</dd><dt>${esc(t('joined'))}</dt><dd>${esc(dt(s.joined))}</dd>${s.guardian ? `<dt>${esc(t('guardian'))}</dt><dd>${esc(nm(s.guardian))} <span dir="ltr">${esc(s.guardian.phone)}</span></dd>` : ''}</dl>
  ${r === 'admin' && s.status === 'active' ? `<div class="bar"><button class="btn" data-act="move-class" data-id="${esc(s.id)}">${esc(t('moveClass'))}</button><button class="btn danger" data-act="withdraw" data-id="${esc(s.id)}">${esc(t('withdraw'))}</button></div>` : ''}</section>
  ${att ? `<section class="card"><h2>${esc(t('attSummary'))}</h2><div class="grid kpis small">${kpi(att.rate == null ? '-' : nf(att.rate) + '%', t('attRate'))}${kpi(nf(att.A), t('daysAbsent'))}${kpi(nf(att.L), t('L'))}</div></section>` : ''}</div>
  ${d.scores && (r === 'admin' || c.teacher === me().id) ? `<p><a class="btn" href="#/report/${esc(s.id)}/1">${esc(t('reportCard'))} · ${esc(t('term1'))}</a> <a class="btn" href="#/report/${esc(s.id)}/2">${esc(t('reportCard'))} · ${esc(t('term2'))}</a></p>` : ''}
  ${s.fin ? statement(s) : ''}`;
}
function statement(s) {
  const d = D(), rows = d.charges.filter((c) => c.studentId === s.id).sort((a, b) => (a.due < b.due ? -1 : 1)), pays = d.payments.filter((p) => p.studentId === s.id), today = d.today, r = role();
  return `<section class="card" style="margin-top:1rem"><div class="bar"><h2>${esc(t('statement'))}</h2><span class="sp"></span>${(r === 'admin' || r === 'accountant') && s.status === 'active' && !rows.length ? `<button class="btn pri" data-act="assign-plan" data-id="${esc(s.id)}">${esc(t('assignPlan'))}</button>` : ''}${(r === 'admin' || r === 'accountant') && s.fin.balance ? `<button class="btn pri" data-act="pay" data-id="${esc(s.id)}">${esc(t('pay'))}</button>` : ''}</div>
  ${rows.length ? `<div class="tw"><table><thead><tr><th>${esc(t('installment'))}</th><th>${esc(t('dueDate'))}</th><th class="num">${esc(t('gross'))}</th><th class="num">${esc(t('discount'))}</th><th class="num">${esc(t('net'))}</th><th class="num">${esc(t('paid'))}</th><th class="num">${esc(t('balance'))}</th></tr></thead><tbody>${rows.map((c) => { const bal = c.amount - c.paid; return `<tr><td>${esc(tx(c, 'label'))}</td><td>${esc(dt(c.due))} ${bal > 0 && c.due < today ? pill('bad', t('overdue')) : ''}</td><td class="num">${esc(money(c.gross))}</td><td class="num">${c.discount ? esc('-' + money(c.discount)) : '-'}</td><td class="num">${esc(money(c.amount))}</td><td class="num">${esc(money(c.paid))}</td><td class="num"><b>${esc(money(bal))}</b></td></tr>`; }).join('')}</tbody></table></div>` : empty(t('noPlan'))}
  ${rows.some((c) => c.discount) ? `<p class="muted small">${esc(t('siblingDisc'))}: 10%</p>` : ''}
  ${r === 'parent' && s.fin.balance ? `<p class="notice">${esc(t('payAtOffice'))}</p>` : ''}
  ${pays.length ? `<h3>${esc(t('receipts'))}</h3><div class="tw"><table><tbody>${pays.map((p) => `<tr class="${p.voided ? 'void' : ''}"><td>${esc(p.no)}</td><td>${esc(dts(p.at))}</td><td>${esc(t(p.method))}</td><td class="num">${esc(money(p.amount))}</td><td>${p.voided ? pill('bad', t('voided')) : ''}</td><td><button class="btn sm" data-act="view-receipt" data-id="${esc(p.id)}">${esc(t('receipt'))}</button></td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
}

// ----- attendance -----
function attDates() {
  const d = D(), cur = d.currentSchoolDay; if (role() === 'teacher') return L.teacherMarkWindow(d.now);
  const out = []; let k = cur; for (let i = 0; i < 10; i++) { out.push(k); k = L.prevSchoolDay(k); } return out;
}
function attInit() {
  const d = D(), cl = d.classes.filter((c) => role() === 'admin' || c.teacher === me().id); if (!cl.length) return null;
  if (!S.att || !cl.some((c) => c.id === S.att.classId)) S.att = { classId: cl[0].id, date: d.currentSchoolDay, marks: null };
  if (!S.att.marks) { const rec = d.attendance.find((r) => r.classId === S.att.classId && r.date === S.att.date); S.att.marks = rec ? { ...rec.marks } : {}; S.att.exists = !!rec; }
  return cl;
}
function attendance() {
  const d = D(), cl = attInit(); if (!cl) return `<h1>${esc(t('attendance'))}</h1>${empty()}`;
  const a = S.att, kids = d.students.filter((s) => s.classId === a.classId && s.status === 'active'), counts = { P: 0, A: 0, L: 0, E: 0 };
  for (const k of kids) if (a.marks[k.id]) counts[a.marks[k.id]]++;
  const done = kids.every((k) => a.marks[k.id]), recent = d.attendance.filter((r) => r.classId === a.classId).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 10);
  const editable = L.canMarkDate(me(), d.now, a.date);
  return `<h1>${esc(t('attendance'))}</h1>${d.schoolDay ? '' : `<p class="notice">${esc(t('weekend'))}</p>`}<div class="bar"><select data-in="att-class" aria-label="${esc(t('class'))}">${cl.map((c) => `<option value="${c.id}" ${a.classId === c.id ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select><select data-in="att-date" aria-label="${esc(t('attDate'))}">${attDates().map((k) => `<option value="${k}" ${a.date === k ? 'selected' : ''}>${esc(dt(k))}</option>`).join('')}</select><span class="sp"></span>${pill(a.exists ? '' : 'off', a.exists ? t('taken') : t('notTaken'))}</div>
  <p class="muted small">${esc(t('attHelp'))} ${role() === 'teacher' ? esc(t('teacherWindow')) : ''}</p>
  <div class="grid two"><section class="card"><div class="bar"><button class="btn" data-act="att-all">${esc(t('allPresent'))}</button><span class="sp"></span>${['P', 'A', 'L', 'E'].map((k) => `<span class="pill ${k === 'A' ? 'bad' : k === 'P' ? '' : k === 'L' ? 'off' : 'gray'}">${esc(t(k))} ${nf(counts[k])}</span>`).join('')}</div>
  <div class="att-list">${kids.map((k) => `<div class="att-row"><span class="nm">${esc(nm(k))}</span><span class="seg" role="group" aria-label="${esc(nm(k))}">${['P', 'A', 'L', 'E'].map((m) => `<button type="button" class="${a.marks[k.id] === m ? 'on ' + m : ''}" data-act="att-mark" data-id="${esc(k.id)}" data-m="${m}" aria-pressed="${a.marks[k.id] === m}">${esc(t(m))}</button>`).join('')}</span></div>`).join('')}</div>
  <div class="bar" style="margin-top:.8rem"><span class="sp"></span><button class="btn pri" data-act="att-save" ${done && editable ? '' : 'disabled'}>${esc(t('saveAtt'))}</button></div>${editable ? '' : `<p class="notice">${esc(t('teacherWindow'))}</p>`}</section>
  <section class="card"><h2>${esc(t('last10'))}</h2><table><tbody>${recent.map((r) => { const v = Object.values(r.marks), p = v.filter((m) => m === 'P' || m === 'L').length; return `<tr><td>${esc(dt(r.date))}</td><td>${nf(p)} / ${nf(v.length)}</td><td>${bar(v.length ? (p / v.length) * 100 : 0, p / v.length < 0.85 ? 'bad' : '')}</td></tr>`; }).join('')}</tbody></table></section></div>`;
}

// ----- grades and report card -----
function grInit() {
  const d = D(), g = d.gradeable || classes().flatMap((c) => c.subjects.map((s) => ({ classId: c.id, subjectId: s })));
  if (!g.length) return null;
  if (!S.gr || !g.some((x) => x.classId === S.gr.classId && x.subjectId === S.gr.subjectId)) S.gr = { classId: g[0].classId, subjectId: g[0].subjectId, term: 1, kind: 'mid', vals: null };
  if (!S.gr.vals) { S.gr.vals = {}; for (const s of d.students.filter((x) => x.classId === S.gr.classId && x.status === 'active')) { const e = d.scores[L.scoreKey(s.id, S.gr.subjectId, S.gr.term, S.gr.kind)]; S.gr.vals[s.id] = e ? String(e.v) : ''; } }
  return g;
}
function grades() {
  const d = D(), g = grInit(); if (!g) return `<h1>${esc(t('grades'))}</h1>${empty()}`;
  const x = S.gr, cls = [...new Set(g.map((y) => y.classId))], subs = g.filter((y) => y.classId === x.classId).map((y) => y.subjectId), max = L.KINDS[x.kind];
  const kids = d.students.filter((s) => s.classId === x.classId && s.status === 'active'), filled = kids.filter((s) => x.vals[s.id] !== '').length, c = clsOf(x.classId);
  return `<h1>${esc(t('grades'))}</h1><div class="bar"><select data-in="gr-class" aria-label="${esc(t('class'))}">${cls.map((i) => `<option value="${i}" ${x.classId === i ? 'selected' : ''}>${esc(classLabel(clsOf(i)))}</option>`).join('')}</select><select data-in="gr-subject" aria-label="${esc(t('subject'))}">${subs.map((i) => `<option value="${i}" ${x.subjectId === i ? 'selected' : ''}>${esc(nm(subOf(i)))}</option>`).join('')}</select><select data-in="gr-term" aria-label="${esc(t('term'))}">${L.TERMS.map((i) => `<option value="${i}" ${x.term === i ? 'selected' : ''}>${esc(t('term' + i))}</option>`).join('')}</select><select data-in="gr-kind" aria-label="${esc(t('kind'))}">${Object.keys(L.KINDS).map((k) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${esc(t('kinds.' + k))} (${L.KINDS[k]})</option>`).join('')}</select></div>
  <p class="muted small">${esc(t('scoreHelp'))}</p><section class="card"><div class="bar"><b>${esc(nm(subOf(x.subjectId)))} · ${esc(t('kinds.' + x.kind))} ${esc(t('outOf'))} ${nf(max)}</b><span class="sp"></span>${pill(filled === kids.length ? '' : 'off', `${nf(filled)} / ${nf(kids.length)} ${t('entered')}`)}</div>
  <div class="tw"><table><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('kinds.' + x.kind))} / ${nf(max)}</th><th></th></tr></thead><tbody>${kids.map((s) => `<tr><td>${esc(nm(s))}</td><td><input class="score" type="number" step="0.5" min="0" max="${max}" inputmode="decimal" data-in="gr-val" data-id="${esc(s.id)}" value="${esc(x.vals[s.id])}" aria-label="${esc(nm(s))}"></td><td>${role() === 'admin' || c.teacher === me().id ? `<a class="btn sm" href="#/report/${esc(s.id)}/${x.term}">${esc(t('openReport'))}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>
  <div class="bar" style="margin-top:.8rem"><span class="sp"></span><button class="btn pri" data-act="gr-save">${esc(t('saveScores'))}</button></div></section>`;
}
function reportPage(id, term) {
  const d = D(), tn = Number(term) === 2 ? 2 : 1, rc = L.reportCard(d, id, tn); if (!rc) return `<p>${esc(t('none'))}</p>`;
  const s = rc.student, c = rc.cls, r = role(), canComment = (r === 'admin' || c.teacher === me().id) && s.status === 'active', ct = teacherOf(c.teacher);
  return `<div class="noprint bar"><a class="text-link" href="#/${r === 'parent' ? 'dashboard' : 'students'}">← ${esc(t('back'))}</a><span class="sp"></span>${[1, 2].map((n) => `<a class="btn sm ${n === tn ? 'pri' : ''}" href="#/report/${esc(id)}/${n}">${esc(t('term' + n))}</a>`).join('')}<button class="btn" data-act="print">${esc(t('print'))}</button></div>
  ${rc.final ? '' : `<p class="notice noprint">${esc(t('provisional'))}</p>`}
  <article class="printable paper"><header class="paper-h"><div>${LOGO}</div><div><h1>${esc(nm(D().school))}</h1><p>${esc(t('reportCard'))} · ${esc(t('term' + tn))} · ${esc(D().school.year)}</p></div></header>
  <dl class="dl two"><dt>${esc(t('name'))}</dt><dd>${esc(nm(s))}</dd><dt>${esc(t('code'))}</dt><dd>${esc(s.code)}</dd><dt>${esc(t('class'))}</dt><dd>${esc(classLabel(c))}</dd><dt>${esc(t('teacherLabel'))}</dt><dd>${esc(nm(ct))}</dd></dl>
  <table class="rc"><thead><tr><th>${esc(t('subject'))}</th><th class="num">${esc(t('coursework'))} /20</th><th class="num">${esc(t('midterm'))} /30</th><th class="num">${esc(t('finalExam'))} /50</th><th class="num">${esc(t('total'))} /100</th><th class="num">${esc(t('grade'))}</th></tr></thead><tbody>${rc.rows.map((x) => `<tr><td>${esc(nm(x.subject))}</td>${['work', 'mid', 'final'].map((k) => `<td class="num">${x.parts[k] == null ? '-' : nf(x.parts[k], x.parts[k] % 1 ? 1 : 0)}</td>`).join('')}<td class="num"><b>${x.total == null ? esc(t('incomplete')) : nf(x.total, x.total % 1 ? 1 : 0)}</b></td><td class="num">${x.letter ? `<b class="gl ${x.letter}">${x.letter}</b>` : '-'}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4">${esc(t('average'))}</td><td class="num"><b>${rc.average == null ? '-' : nf(rc.average, 1)}</b></td><td class="num">${rc.letter ? `<b class="gl ${rc.letter}">${rc.letter}</b>` : '-'}</td></tr></tfoot></table>
  <p>${rc.final ? esc(t('finalCard')) : esc(t('provisional'))}</p>
  <p><b>${esc(t('attSummary'))}:</b> ${rc.att.rate == null ? '-' : nf(rc.att.rate) + '%'} · ${esc(t('P'))} ${nf(rc.att.P)} · ${esc(t('A'))} ${nf(rc.att.A)} · ${esc(t('L'))} ${nf(rc.att.L)} · ${esc(t('E'))} ${nf(rc.att.E)}</p>
  <div class="comment"><b>${esc(t('teacherComment'))}</b><p id="remark-view">${rc.remark ? esc(ar() && rc.remark.textAr ? rc.remark.textAr : rc.remark.text) : '-'}</p></div>
  ${canComment ? `<div class="noprint"><textarea id="remark" rows="2" maxlength="200" aria-label="${esc(t('teacherComment'))}">${esc(rc.remark?.text || '')}</textarea><button class="btn sm" data-act="save-remark" data-id="${esc(id)}" data-term="${tn}">${esc(t('saveComment'))}</button></div>` : ''}
  <footer class="sign"><span>${esc(t('signTeacher'))}</span><span>${esc(t('signPrincipal'))}</span><span>${esc(t('signParent'))}</span></footer><p class="muted small">${esc(t('printed'))}: ${esc(dt(D().today))}</p></article>`;
}
function progress() {
  const kids = D().students; if (!kids.length) return empty();
  if (!S.child || !kids.some((k) => k.id === S.child)) S.child = kids[0].id;
  return reportPage(S.child, S.term);
}

// ----- fees -----
function fees() {
  const d = D(), r = role(); if (r === 'parent') return parentFees();
  const q = S.q.toLowerCase();
  const list = d.students.filter((s) => (!S.classF || s.classId === S.classF) && (!S.overdueOnly || s.fin.overdue) && (!q || s.name.toLowerCase().includes(q) || (s.nameAr || '').includes(S.q) || s.code.toLowerCase().includes(q)));
  return `<h1>${esc(t('fees'))}</h1>${financeCards(d.finance)}<div class="bar" style="margin-top:1rem"><input data-in="q" value="${esc(S.q)}" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}"><select data-in="classF" aria-label="${esc(t('class'))}"><option value="">${esc(t('allClasses'))}</option>${classes().map((c) => `<option value="${c.id}" ${S.classF === c.id ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select><label class="chk"><input type="checkbox" data-in="overdueOnly" ${S.overdueOnly ? 'checked' : ''}> ${esc(t('overdueOnly'))}</label></div>
  <div class="tw"><table><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('class'))}</th><th class="num">${esc(t('billed'))}</th><th class="num">${esc(t('paid'))}</th><th class="num">${esc(t('balance'))}</th><th>${esc(t('nextDue'))}</th><th></th></tr></thead><tbody>${list.map((s) => `<tr><td><a href="#/student/${esc(s.id)}">${esc(nm(s))}</a></td><td>${esc(classLabel(clsOf(s.classId)))}</td><td class="num">${esc(money(s.fin.billed))}</td><td class="num">${esc(money(s.fin.paid))}</td><td class="num">${s.fin.overdue ? pill('bad', money(s.fin.balance)) : esc(money(s.fin.balance))}</td><td>${s.fin.overdue ? pill('bad', `${t('overdue')} · ${nf(s.fin.daysLate)}`) : s.fin.next ? esc(dt(s.fin.next.due)) : ''}</td><td>${!s.fin.hasPlan && s.status === 'active' ? `<button class="btn sm" data-act="assign-plan" data-id="${esc(s.id)}">${esc(t('assignPlan'))}</button>` : s.fin.balance ? `<button class="btn sm pri" data-act="pay" data-id="${esc(s.id)}">${esc(t('pay'))}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function parentFees() { return `<h1>${esc(t('fees'))}</h1>${D().students.map((s) => `<h2>${esc(nm(s))}</h2>${statement(s)}`).join('')}`; }
function overdueTable(rows) {
  const d = D(), r = role();
  if (!rows.length) return empty();
  return `<div class="tw"><table><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('guardian'))}</th><th class="num">${esc(t('overdue'))}</th><th>${esc(t('oldestDue'))}</th><th class="num">${esc(t('daysLate'))}</th><th></th></tr></thead><tbody>${rows.map((o) => { const s = stOf(o.studentId), rem = o.lastReminder && L.daysBetween(L.dayKey(o.lastReminder), d.today) < L.REMIND_GAP_DAYS; return `<tr><td><a href="#/student/${esc(s.id)}">${esc(nm(s))}</a><br><small class="muted">${esc(classLabel(clsOf(s.classId)))}</small></td><td>${s.guardian ? `${esc(nm(s.guardian))}<br><a dir="ltr" href="tel:${esc(s.guardian.phone)}">${esc(s.guardian.phone)}</a>` : ''}</td><td class="num"><b>${esc(money(o.overdue))}</b></td><td>${esc(dt(o.oldestDue))}</td><td class="num">${pill(o.daysLate > 60 ? 'bad' : o.daysLate > 30 ? 'off' : 'gray', nf(o.daysLate))}</td><td>${rem ? pill('gray', `${t('reminded')} ${dts(o.lastReminder)}`) : `<button class="btn sm" data-act="remind" data-id="${esc(s.id)}">${esc(t('remind'))}</button>`}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function overduePage() {
  const f = D().finance; return `<div class="bar"><h1>${esc(t('overdue'))}</h1><span class="sp"></span><button class="btn" data-act="csv-overdue">${esc(t('csv'))}</button></div>${financeCards(f)}<div style="margin-top:1rem">${overdueTable(f.overdueStudents)}</div>`;
}
function receipts() {
  const d = D(), q = S.rcptQ.toLowerCase(), list = d.payments.filter((p) => !q || p.no.toLowerCase().includes(q) || (stOf(p.studentId)?.name || '').toLowerCase().includes(q));
  return `<div class="bar"><h1>${esc(t('receipts'))}</h1><span class="sp"></span><input data-in="rcptQ" value="${esc(S.rcptQ)}" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}"><button class="btn" data-act="csv-payments">${esc(t('csv'))}</button></div>
  <div class="tw"><table><thead><tr><th>${esc(t('receiptNo'))}</th><th>${esc(t('date'))}</th><th>${esc(t('name'))}</th><th>${esc(t('method'))}</th><th class="num">${esc(t('amount'))}</th><th>${esc(t('takenBy'))}</th><th></th></tr></thead><tbody>${list.map((p) => `<tr class="${p.voided ? 'void' : ''}"><td>${esc(p.no)}</td><td>${esc(dts(p.at))}</td><td>${esc(nm(stOf(p.studentId) || { name: '?' }))}</td><td>${esc(t(p.method))}</td><td class="num">${esc(money(p.amount))}</td><td>${esc(p.byName)}</td><td>${p.voided ? pill('bad', t('voided')) : ''} <button class="btn sm" data-act="view-receipt" data-id="${esc(p.id)}">${esc(t('receipt'))}</button></td></tr>`).join('')}</tbody></table></div>${list.length ? '' : empty()}`;
}

// ----- timetable, announcements, people, audit -----
function timetable() {
  const d = D(), cl = d.classes; if (!cl.length) return empty();
  if (!S.tt || !cl.some((c) => c.id === S.tt)) S.tt = cl[0].id;
  const cls = clsOf(S.tt), slot = (day, p) => d.slots.find((x) => x.classId === S.tt && x.day === day && x.period === p), isAdmin = role() === 'admin';
  const own = (x) => x && x.teacherId === me().id;
  return `<h1>${esc(t('timetable'))}</h1><div class="bar"><select data-in="tt" aria-label="${esc(t('class'))}">${(d.allClasses || cl).map((c) => `<option value="${c.id}" ${S.tt === c.id ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select><span class="muted">${esc(t('teacherLabel'))}: ${esc(nm(teacherOf(cls.teacher)))}</span>${role() === 'teacher' ? `<span class="muted small">${esc(t('mine'))}</span>` : ''}</div>
  <div class="tw"><table class="tt"><thead><tr><th>${esc(t('period'))}</th>${t('days').map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${[1, 2, 3, 4, 5].map((p) => `<tr><th>${p}<br><small>${esc(t('times')[p - 1])}</small></th>${[0, 1, 2, 3, 4].map((day) => { const x = slot(day, p); return `<td class="${own(x) ? 'mine' : ''}">${x ? `<b>${esc(nm(subOf(x.subjectId)))}</b><br><small>${esc(nm(teacherOf(x.teacherId)))}</small>` : `<span class="muted">${esc(t('free'))}</span>`}${isAdmin ? `<br><button class="btn sm" data-act="edit-slot" data-day="${day}" data-p="${p}">${esc(t('edit'))}</button>` : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function announcements() {
  const r = role(), d = D(), canPost = r === 'admin' || r === 'teacher';
  const auds = r === 'admin' ? [['all', t('audAll')], ['parents', t('audParents')], ['teachers', t('audTeachers')], ...d.classes.map((c) => ['class:' + c.id, t('audClass') + classLabel(c)])] : d.classes.map((c) => ['class:' + c.id, t('audClass') + classLabel(c)]);
  if (!auds.some((a) => a[0] === S.annAud)) S.annAud = auds[0]?.[0];
  return `<h1>${esc(t('announcements'))}</h1>${canPost ? `<section class="card"><h2>${esc(t('newAnn'))}</h2><form data-form="ann"><div class="f"><label for="a-title">${esc(t('title'))}</label><input id="a-title" maxlength="80"></div><div class="f"><label for="a-body">${esc(t('message'))}</label><textarea id="a-body" rows="3" maxlength="600"></textarea></div><div class="row"><div class="f"><label for="a-aud">${esc(t('audience'))}</label><select id="a-aud">${auds.map(([v, l]) => `<option value="${esc(v)}" ${S.annAud === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>${r === 'admin' ? `<label class="chk" style="align-self:end"><input id="a-pin" type="checkbox"> ${esc(t('pinIt'))}</label>` : ''}</div><button class="btn pri" type="submit">${esc(t('post'))}</button></form></section><div style="height:1rem"></div>` : ''}${annList(d.announcements)}`;
}
function people() {
  const d = D(), by = (r) => d.users.filter((u) => u.role === r), kids = (id) => d.students.filter((s) => s.parentId === id).length;
  return `<div class="bar"><h1>${esc(t('people'))}</h1><span class="sp"></span><button class="btn pri" data-act="add-user">${esc(t('addUser'))}</button></div>${['teacher', 'accountant', 'parent', 'admin'].map((r) => `<h2>${esc(t('role.' + r))} (${nf(by(r).length)})</h2><div class="tw"><table><tbody>${by(r).map((u) => `<tr><td>${esc(nm(u))}</td><td dir="ltr">${esc(u.phone || '')}</td>${r === 'parent' ? `<td>${nf(kids(u.id))} ${esc(t('children'))}</td>` : '<td></td>'}</tr>`).join('')}</tbody></table></div>`).join('')}`;
}
function auditPage() {
  return `<h1>${esc(t('auditTrail'))}</h1><div class="tw"><table><thead><tr><th>${esc(t('when'))}</th><th>${esc(t('who'))}</th><th>${esc(t('action'))}</th><th>${esc(t('detail'))}</th></tr></thead><tbody>${D().audit.map((a) => `<tr><td>${esc(dts(a.at))} ${esc(tm(a.at))}</td><td>${esc(a.byName)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>${D().audit.length ? '' : empty()}`;
}

// ---------- modals ----------
function receiptHtml(p) {
  const s = stOf(p.studentId), d = D();
  return `<div class="receipt printable"><h3>${esc(nm(d.school))}</h3><p class="c">${esc(t('receipt'))} ${esc(p.no)}${p.voided ? ' · ' + esc(t('voided')) : ''}</p><hr><div class="r"><span>${esc(t('date'))}</span><span>${esc(dts(p.at))} ${esc(tm(p.at))}</span></div><div class="r"><span>${esc(t('name'))}</span><span>${esc(nm(s))}</span></div><div class="r"><span>${esc(t('class'))}</span><span>${esc(classLabel(clsOf(s.classId)))}</span></div><hr>${p.allocs.map((a) => { const c = d.charges.find((x) => x.id === a.chargeId); return `<div class="r"><span>${esc(c ? tx(c, 'label') : '')}</span><span>${esc(money(a.amount))}</span></div>`; }).join('')}<hr><div class="r big"><span>${esc(t('amount'))}</span><span>${esc(money(p.amount))}</span></div><div class="r"><span>${esc(t('method'))}</span><span>${esc(t(p.method))}</span></div><div class="r"><span>${esc(t('takenBy'))}</span><span>${esc(p.byName)}</span></div>${p.voided ? `<hr><p class="c">${esc(t('voided'))}: ${esc(p.voided.reason)}</p>` : ''}</div>`;
}
const field = (id, label, inner) => `<div class="f"><label for="${id}">${esc(label)}</label>${inner}</div>`;
function modalHtml() {
  const m = S.modal, d = D(); if (!m) return '';
  const wrap = (title, body, acts, wide) => `<div class="modal-bg" data-act="bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}<div class="acts noprint">${acts}</div></div></div>`;
  const cancel = `<button class="btn" data-act="close">${esc(t('cancel'))}</button>`;
  if (m.type === 'receipt') { const p = d.payments.find((x) => x.id === m.id); return wrap(t('receipt'), receiptHtml(p), `${role() === 'admin' && !p.voided ? `<button class="btn danger" data-act="void" data-id="${esc(p.id)}">${esc(t('void'))}</button>` : ''}<button class="btn" data-act="print">${esc(t('print'))}</button><button class="btn pri" data-act="close">${esc(t('close'))}</button>`); }
  if (m.type === 'pay') {
    const s = stOf(m.id), rows = L.chargeRows({ charges: d.charges.filter((c) => c.studentId === s.id).map((c) => ({ ...c })), payments: [{ voided: null, allocs: d.charges.filter((c) => c.studentId === s.id).map((c) => ({ chargeId: c.id, amount: c.paid })) }] }, s.id, d.today).filter((r) => r.balance > 0);
    return wrap(`${t('pay')}: ${nm(s)}`, `<table><tbody>${rows.map((r) => `<tr><td>${esc(tx(r, 'label'))}</td><td>${esc(dt(r.due))}${r.overdue ? ' ' + pill('bad', t('overdue')) : ''}</td><td class="num">${esc(money(r.balance))}</td></tr>`).join('')}</tbody></table><p class="muted small">${esc(t('payHelp'))}</p><div class="quick"><button class="btn sm" data-act="pay-fill" data-v="${s.fin.overdue}" ${s.fin.overdue ? '' : 'disabled'}>${esc(t('fullOverdue'))}</button><button class="btn sm" data-act="pay-fill" data-v="${s.fin.balance}">${esc(t('fullBalance'))}</button></div>${field('pay-amt', t('payAmount'), `<input id="pay-amt" inputmode="decimal" value="${s.fin.overdue ? (s.fin.overdue / 100).toFixed(2) : ''}">`)}${field('pay-method', t('method'), `<select id="pay-method">${L.METHODS.map((k) => `<option value="${k}">${esc(t(k))}</option>`).join('')}</select>`)}${field('pay-note', `${t('note')} (${t('optional')})`, '<input id="pay-note" maxlength="80">')}`, `${cancel}<button class="btn pri" data-act="pay-go">${esc(t('confirm'))}</button>`);
  }
  if (m.type === 'plan') { const s = stOf(m.id); return wrap(`${t('assignPlan')}: ${nm(s)}`, `<p class="muted small">${esc(t('plansHelp'))}</p>${field('plan-id', t('plan'), `<select id="plan-id">${d.plans.map((p) => `<option value="${p.id}" ${(s.classId <= 'c2' ? 'pl-kg' : s.classId <= 'c4' ? 'pl-p1' : 'pl-p2') === p.id ? 'selected' : ''}>${esc(tx(p, 'name'))} · ${esc(money(p.total))}</option>`).join('')}</select>`)}`, `${cancel}<button class="btn pri" data-act="plan-go">${esc(t('confirm'))}</button>`); }
  if (m.type === 'void') return wrap(t('void'), field('void-reason', t('voidReason'), '<input id="void-reason" maxlength="100">'), `${cancel}<button class="btn danger" data-act="void-go">${esc(t('void'))}</button>`);
  if (m.type === 'student') return wrap(t('addStudent'), `${field('s-name', t('studentName'), '<input id="s-name" maxlength="60">')}${field('s-nameAr', t('studentNameAr'), '<input id="s-nameAr" maxlength="60" dir="rtl">')}${field('s-class', t('pickClass'), `<select id="s-class">${d.allClasses.map((c) => `<option value="${c.id}">${esc(classLabel(c))} (${nf(c.count)}/${nf(c.capacity)})</option>`).join('')}</select>`)}${field('s-dob', t('dob'), '<input id="s-dob" placeholder="2020-09-01" dir="ltr">')}${field('s-guard', t('pickGuardian'), `<select id="s-guard">${d.parents.map((p) => `<option value="${p.id}">${esc(nm(p))}</option>`).join('')}</select>`)}`, `${cancel}<button class="btn pri" data-act="student-go">${esc(t('save'))}</button>`);
  if (m.type === 'move') return wrap(t('moveClass'), field('m-class', t('pickClass'), `<select id="m-class">${d.allClasses.map((c) => `<option value="${c.id}">${esc(classLabel(c))} (${nf(c.count)}/${nf(c.capacity)})</option>`).join('')}</select>`), `${cancel}<button class="btn pri" data-act="move-go">${esc(t('save'))}</button>`);
  if (m.type === 'withdraw') return wrap(t('withdraw'), `<p class="notice">${esc(t('withdrawHelp'))}</p>${field('w-reason', t('reason'), '<input id="w-reason" maxlength="100">')}`, `${cancel}<button class="btn danger" data-act="withdraw-go">${esc(t('withdraw'))}</button>`);
  if (m.type === 'user') return wrap(t('addUser'), `${field('u-name', t('userName'), '<input id="u-name" maxlength="60">')}${field('u-nameAr', t('studentNameAr'), '<input id="u-nameAr" maxlength="60" dir="rtl">')}${field('u-role', t('userRole'), `<select id="u-role">${['parent', 'teacher', 'accountant'].map((r) => `<option value="${r}">${esc(t('role.' + r))}</option>`).join('')}</select>`)}${field('u-phone', t('phone'), '<input id="u-phone" maxlength="20" dir="ltr">')}${field('u-pin', t('userPin'), '<input id="u-pin" inputmode="numeric" maxlength="4" dir="ltr">')}`, `${cancel}<button class="btn pri" data-act="user-go">${esc(t('save'))}</button>`);
  if (m.type === 'slot') {
    const cur = d.slots.find((x) => x.classId === S.tt && x.day === m.day && x.period === m.p), c = clsOf(S.tt);
    return wrap(`${t('days')[m.day]} · ${t('period')} ${m.p}`, `${field('sl-sub', t('subject'), `<select id="sl-sub">${c.subjects.map((s) => `<option value="${s}" ${cur?.subjectId === s ? 'selected' : ''}>${esc(nm(subOf(s)))}</option>`).join('')}</select>`)}${field('sl-teacher', t('teacher'), `<select id="sl-teacher">${d.teachers.map((x) => `<option value="${x.id}" ${cur?.teacherId === x.id ? 'selected' : ''}>${esc(nm(x))}</option>`).join('')}</select>`)}`, `${cancel}${cur ? `<button class="btn danger" data-act="slot-clear">${esc(t('clearSlot'))}</button>` : ''}<button class="btn pri" data-act="slot-go">${esc(t('setSlot'))}</button>`);
  }
  return '';
}

// ---------- render ----------
function page() {
  const r = route();
  switch (r.p) {
    case 'students': return students(); case 'student': return studentPage(r.a); case 'attendance': return attendance(); case 'grades': return grades();
    case 'report': return reportPage(r.a, r.b); case 'progress': return progress(); case 'fees': return fees(); case 'receipts': return receipts(); case 'overdue': return overduePage();
    case 'timetable': return timetable(); case 'announcements': return announcements(); case 'people': return role() === 'admin' ? people() : dashboard(); case 'audit': return role() === 'admin' ? auditPage() : dashboard();
    default: return dashboard();
  }
}
let rendering = false;
function render() {
  const root = $('#app'); document.documentElement.lang = S.lang; document.documentElement.dir = T[S.lang].dir; document.title = `${t('appName')} | ${t('appSub')}`;
  if (!S.token || !S.data) { root.innerHTML = login_(); return; }
  const ok = NAV[role()].includes(route().p) || ['student', 'report'].includes(route().p);
  root.innerHTML = `${top()}<main>${S.err ? `<p class="notice bad">${esc(S.err)}</p>` : ''}${ok ? page() : dashboard()}</main><div id="modal">${modalHtml()}</div>`;
}
const csvDownload = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.append(a); a.click(); a.remove(); };
const val = (id) => $('#' + id)?.value ?? '';

// ---------- events ----------
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
  if (f.dataset.form === 'login') return login($('#pin').value.trim());
  if (f.dataset.form === 'ann') { const r = await act({ type: 'postAnnouncement', title: val('a-title'), body: val('a-body'), audience: val('a-aud'), pinned: !!$('#a-pin')?.checked }, t('saved')); if (r) render(); }
});
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.in; if (!k) return;
  if (k === 'gr-val') { S.gr.vals[e.target.dataset.id] = e.target.value; return; }
  if (k === 'q' || k === 'rcptQ') { S[k] = e.target.value; const pos = e.target.selectionStart; render(); const el = $(`[data-in=${k}]`); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.in; if (!k || k === 'gr-val' || k === 'q' || k === 'rcptQ') return; const v = e.target.value;
  if (k === 'classF') S.classF = v; else if (k === 'overdueOnly') S.overdueOnly = e.target.checked; else if (k === 'tt') S.tt = v;
  else if (k === 'att-class') S.att = { classId: v, date: S.att.date, marks: null }; else if (k === 'att-date') S.att = { classId: S.att.classId, date: v, marks: null };
  else if (k === 'gr-class') S.gr = { ...S.gr, classId: v, subjectId: D().gradeable.find((x) => x.classId === v)?.subjectId, vals: null };
  else if (k === 'gr-subject') S.gr = { ...S.gr, subjectId: v, vals: null }; else if (k === 'gr-term') S.gr = { ...S.gr, term: Number(v), vals: null }; else if (k === 'gr-kind') S.gr = { ...S.gr, kind: v, vals: null };
  else if (k === 'annAud') S.annAud = v;
  render();
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return; const a = el.dataset.act, id = el.dataset.id;
  if (a === 'bg') { if (e.target === el) { S.modal = null; render(); } return; }
  const done = async (op, msg, after) => { const r = await act(op, msg); if (r) { S.modal = null; after && after(r); render(); } };
  switch (a) {
    case 'lang': S.lang = S.lang === 'en' ? 'ar' : 'en'; LS.set('lang', S.lang); return render();
    case 'logout': return logout();
    case 'demo': return login(el.dataset.pin);
    case 'close': S.modal = null; return render();
    case 'print': return window.print();
    case 'reset': if (confirm(t('resetAsk'))) { const r = await act({ type: 'reset' }, t('resetDone')); if (r) { S.att = S.gr = null; render(); } } return;
    case 'view-receipt': S.modal = { type: 'receipt', id }; return render();
    case 'pay': S.modal = { type: 'pay', id, req: rid() }; return render();
    case 'pay-fill': $('#pay-amt').value = (Number(el.dataset.v) / 100).toFixed(2); return;
    case 'pay-go': { const amount = toCents(val('pay-amt')); return done({ type: 'payment', studentId: S.modal.id, amount, method: val('pay-method'), note: val('pay-note'), reqId: S.modal.req }, null, (r) => { toast(r.duplicate ? t('dup') : t('payDone')); S.modal = { type: 'receipt', id: D().payments.find((p) => p.no === r.no).id }; }); }
    case 'void': S.modal = { type: 'void', id }; return render();
    case 'void-go': return done({ type: 'voidPayment', paymentId: S.modal.id, reason: val('void-reason') }, t('saved'));
    case 'assign-plan': S.modal = { type: 'plan', id }; return render();
    case 'plan-go': return done({ type: 'assignPlan', studentId: S.modal.id, planId: val('plan-id') }, t('saved'));
    case 'remind': { const r = await act({ type: 'remind', studentId: id }, t('remindSent')); if (r) render(); return; }
    case 'add-student': S.modal = { type: 'student' }; return render();
    case 'student-go': return done({ type: 'addStudent', name: val('s-name'), nameAr: val('s-nameAr'), classId: val('s-class'), dob: val('s-dob'), parentId: val('s-guard') }, t('saved'), (r) => { location.hash = '#/student/' + r.id; });
    case 'move-class': S.modal = { type: 'move', id }; return render();
    case 'move-go': return done({ type: 'moveClass', studentId: S.modal.id, classId: val('m-class') }, t('saved'));
    case 'withdraw': S.modal = { type: 'withdraw', id }; return render();
    case 'withdraw-go': return done({ type: 'withdraw', studentId: S.modal.id, reason: val('w-reason') }, t('withdrawn1'));
    case 'add-user': S.modal = { type: 'user' }; return render();
    case 'user-go': return done({ type: 'addUser', name: val('u-name'), nameAr: val('u-nameAr'), role: val('u-role'), phone: val('u-phone'), pin: val('u-pin') }, t('saved'));
    case 'att-all': for (const s of D().students.filter((x) => x.classId === S.att.classId && x.status === 'active')) S.att.marks[s.id] = 'P'; return render();
    case 'att-mark': S.att.marks[id] = el.dataset.m; return render();
    case 'att-save': { const r = await act({ type: 'markAttendance', classId: S.att.classId, date: S.att.date, marks: S.att.marks }, t('saved')); if (r) { S.att.marks = null; render(); } return; }
    case 'gr-save': { const g = S.gr; const r = await act({ type: 'setScores', classId: g.classId, subjectId: g.subjectId, term: g.term, kind: g.kind, scores: g.vals }, t('saved')); if (r) { S.gr.vals = null; render(); } return; }
    case 'save-remark': { const r = await act({ type: 'setRemark', studentId: id, term: Number(el.dataset.term), text: val('remark') }, t('saved')); if (r) render(); return; }
    case 'del-ann': { const r = await act({ type: 'deleteAnnouncement', id }, t('saved')); if (r) render(); return; }
    case 'edit-slot': S.modal = { type: 'slot', day: Number(el.dataset.day), p: Number(el.dataset.p) }; return render();
    case 'slot-go': return done({ type: 'setSlot', classId: S.tt, day: S.modal.day, period: S.modal.p, subjectId: val('sl-sub'), teacherId: val('sl-teacher') }, t('saved'));
    case 'slot-clear': return done({ type: 'clearSlot', classId: S.tt, day: S.modal.day, period: S.modal.p }, t('saved'));
    case 'csv-overdue': return csvDownload('overdue.csv', L.overdueCsv(D()));
    case 'csv-payments': return csvDownload('receipts.csv', L.paymentsCsv(D()));
  }
});
addEventListener('hashchange', () => { S.modal = null; render(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) { S.modal = null; render(); } });

(async function boot() {
  if (S.token) await refresh(); else render();
  if (S.token && !S.data) { LS.del('token'); S.token = null; }
  render();
})();

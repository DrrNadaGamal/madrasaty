// Madrasaty business rules. Pure functions, no I/O: the API, the browser app and the tests all import this file.
// All money is stored in piasters (1 EGP = 100) as integers, so totals never drift.

export class UserError extends Error {}
const bad = (m) => { throw new UserError(m); };

export const TZ = 'Africa/Cairo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayKey = (t) => dayFmt.format(new Date(t));
const utc = (k) => Date.parse(k + 'T00:00:00Z');
export const addDays = (k, n) => new Date(utc(k) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const dow = (k) => new Date(utc(k)).getUTCDay(); // 0 = Sunday
export const isSchoolDay = (k) => dow(k) <= 4; // Egyptian school week: Sunday to Thursday
export const prevSchoolDay = (k) => { let d = addDays(k, -1); while (!isSchoolDay(d)) d = addDays(d, -1); return d; };
export const currentSchoolDay = (now) => { const k = dayKey(now); return isSchoolDay(k) ? k : prevSchoolDay(k); };
const validDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && addDays(k, 0) === k;

export const egp = (c) => (c / 100).toFixed(2);
const isInt = (n) => Number.isInteger(n);
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const pad = (n, w = 6) => String(n).padStart(w, '0');

export const ROLES = { admin: 'admin', teacher: 'teacher', accountant: 'accountant', parent: 'parent' };
export const SIBLING_PCT = 10;
export const KINDS = { work: 20, mid: 30, final: 50 }; // coursework 20 + midterm 30 + final exam 50 = 100
export const TERMS = [1, 2];
export const ATT = ['P', 'A', 'L', 'E']; // present, absent, late, excused
export const METHODS = ['cash', 'card', 'transfer'];
export const REMIND_GAP_DAYS = 7;
export const PERIODS = 5;
export const ADMIN_BACKFILL_DAYS = 30;
export const letter = (pct) => (pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F');

const need = (user, ...roles) => { if (!roles.includes(user.role)) throw new UserError('You do not have permission to do this'); };
const nextId = (state, p) => { state.seq[p] = (state.seq[p] || 0) + 1; return p + state.seq[p]; };
const audit = (state, user, now, action, detail) => { state.audit.push({ at: now, by: user.id, byName: user.name, action, detail: clean(detail, 160) }); };

// ---------- lookups ----------
export const byId = (list, id) => list.find((x) => x.id === id);
export const activeIn = (state, classId) => state.students.filter((s) => s.classId === classId && s.status === 'active');
export const guardianKids = (state, parentId) => state.students.filter((s) => s.parentId === parentId);
export function teachesIn(state, userId, classId, subjectId) {
  const c = byId(state.classes, classId);
  if (!c) return false;
  if (c.teacher === userId) return true;
  return state.slots.some((x) => x.classId === classId && x.teacherId === userId && (!subjectId || x.subjectId === subjectId));
}
export const myClassIds = (state, user) => (user.role === 'teacher' ? state.classes.filter((c) => teachesIn(state, user.id, c.id)).map((c) => c.id) : []);
export function canGrade(state, user, classId, subjectId) {
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher') return false;
  const c = byId(state.classes, classId);
  return !!c && (c.teacher === user.id || state.slots.some((x) => x.classId === classId && x.subjectId === subjectId && x.teacherId === user.id));
}

// ---------- fees ----------
export function paidMap(state) {
  const m = new Map();
  for (const p of state.payments) if (!p.voided) for (const a of p.allocs) m.set(a.chargeId, (m.get(a.chargeId) || 0) + a.amount);
  return m;
}
export const liveCharges = (state, studentId) => state.charges.filter((c) => c.studentId === studentId && !c.cancelled);
export function chargeRows(state, studentId, today, pm = paidMap(state)) {
  return liveCharges(state, studentId).map((c) => {
    const paid = pm.get(c.id) || 0, balance = c.amount - paid;
    return { ...c, paid, balance, overdue: balance > 0 && c.due < today, daysLate: balance > 0 && c.due < today ? daysBetween(c.due, today) : 0 };
  }).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id < b.id ? -1 : 1));
}
export function studentFinance(state, studentId, today, pm = paidMap(state)) {
  const rows = chargeRows(state, studentId, today, pm);
  const billed = rows.reduce((s, r) => s + r.amount, 0), paid = rows.reduce((s, r) => s + r.paid, 0);
  const overdue = rows.filter((r) => r.overdue).reduce((s, r) => s + r.balance, 0);
  const next = rows.find((r) => r.balance > 0 && !r.overdue) || null;
  const oldest = rows.find((r) => r.overdue) || null;
  return { billed, paid, balance: billed - paid, overdue, next: next && { label: next.label, labelAr: next.labelAr, due: next.due, amount: next.balance }, oldestDue: oldest ? oldest.due : null, daysLate: oldest ? oldest.daysLate : 0, hasPlan: rows.length > 0 };
}
export function splitPlan(total, installments) {
  let used = 0;
  return installments.map((ins, i) => { const a = i === installments.length - 1 ? total - used : Math.round((total * ins.pct) / 100); used += a; return a; });
}
export function planCharges(state, student, plan) {
  const sibling = state.students.some((s) => s.id !== student.id && s.parentId === student.parentId && s.status === 'active' && state.charges.some((c) => c.studentId === s.id && !c.cancelled));
  const gross = splitPlan(plan.total, plan.installments);
  return plan.installments.map((ins, i) => {
    const disc = sibling ? Math.round((gross[i] * SIBLING_PCT) / 100) : 0;
    return { id: nextId(state, 'ch'), studentId: student.id, planId: plan.id, label: ins.label, labelAr: ins.labelAr, due: ins.due, gross: gross[i], discount: disc, amount: gross[i] - disc, cancelled: false };
  });
}
function addPayment(state, { studentId, amount, method, note, at, by, byName, reqId }) {
  const st = byId(state.students, studentId);
  if (!st) bad('Student not found');
  if (!isInt(amount) || amount <= 0) bad('Enter an amount greater than zero');
  if (!METHODS.includes(method)) bad('Choose cash, card or transfer');
  if (reqId) { const dup = state.payments.find((p) => p.reqId === reqId); if (dup) return { payment: dup, duplicate: true }; }
  const rows = chargeRows(state, studentId, dayKey(at)).filter((r) => r.balance > 0);
  const owing = rows.reduce((s, r) => s + r.balance, 0);
  if (amount > owing) bad(`The amount is more than what is owed (${egp(owing)} EGP)`);
  let left = amount; const allocs = [];
  for (const r of rows) { if (!left) break; const a = Math.min(left, r.balance); allocs.push({ chargeId: r.id, amount: a }); left -= a; }
  const payment = { id: nextId(state, 'p'), no: 'RC-' + pad(state.seq.rc = (state.seq.rc || 0) + 1), studentId, amount, method, note: clean(note, 80), at, by, byName, allocs, reqId: reqId || null, voided: null };
  state.payments.push(payment);
  return { payment, duplicate: false };
}

export function financeSummary(state, now) {
  const today = dayKey(now), pm = paidMap(state);
  let billed = 0, paid = 0, overdue = 0, upcoming30 = 0; const aging = { d30: 0, d60: 0, d61: 0 }; const per = [];
  for (const s of state.students) {
    const rows = chargeRows(state, s.id, today, pm); let od = 0, oldest = null;
    for (const r of rows) {
      billed += r.amount; paid += r.paid;
      if (r.overdue) { overdue += r.balance; od += r.balance; if (!oldest) oldest = r; aging[r.daysLate <= 30 ? 'd30' : r.daysLate <= 60 ? 'd60' : 'd61'] += r.balance; }
      else if (r.balance > 0 && daysBetween(today, r.due) <= 30) upcoming30 += r.balance;
    }
    if (od) { const rem = state.reminders.filter((x) => x.studentId === s.id).sort((a, b) => b.at - a.at)[0]; per.push({ studentId: s.id, overdue: od, oldestDue: oldest.due, daysLate: oldest.daysLate, lastReminder: rem ? rem.at : null }); }
  }
  per.sort((a, b) => b.daysLate - a.daysLate || b.overdue - a.overdue);
  const live = state.payments.filter((p) => !p.voided);
  const series = []; for (let i = 13; i >= 0; i--) { const k = addDays(today, -i); series.push({ day: k, amount: live.filter((p) => dayKey(p.at) === k).reduce((s, p) => s + p.amount, 0) }); }
  const byMethod = {}; for (const p of live) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
  return { billed, collected: paid, outstanding: billed - paid, overdue, upcoming30, aging, overdueStudents: per, series, byMethod, collectedToday: series[13].amount };
}

// ---------- attendance ----------
export function attendanceStats(records, studentId) {
  const c = { P: 0, A: 0, L: 0, E: 0 };
  for (const r of records) { const m = r.marks[studentId]; if (m) c[m]++; }
  const counted = c.P + c.L + c.A; // excused days are left out of the rate
  return { ...c, days: c.P + c.A + c.L + c.E, rate: counted ? Math.round(((c.P + c.L) / counted) * 100) : null };
}
export function teacherMarkWindow(now) { const cur = currentSchoolDay(now); return [cur, prevSchoolDay(cur)]; }
export function canMarkDate(user, now, date) {
  if (!validDate(date) || !isSchoolDay(date)) return false;
  const today = dayKey(now);
  if (date > today) return false;
  if (user.role === 'admin') return daysBetween(date, today) <= ADMIN_BACKFILL_DAYS;
  return user.role === 'teacher' && teacherMarkWindow(now).includes(date);
}

// ---------- grades and report card ----------
export const scoreKey = (sid, sub, term, kind) => `${sid}.${sub}.${term}.${kind}`;
export function reportCard(data, studentId, term) {
  const st = byId(data.students, studentId); if (!st) return null;
  const cls = byId(data.classes, st.classId);
  const subjects = (cls?.subjects || []).map((sid) => byId(data.subjects, sid)).filter(Boolean);
  const rows = subjects.map((sub) => {
    const parts = {}; let total = 0, complete = true;
    for (const k of Object.keys(KINDS)) { const e = data.scores[scoreKey(studentId, sub.id, term, k)]; if (e == null) { complete = false; parts[k] = null; } else { parts[k] = e.v; total += e.v; } }
    return { subject: sub, parts, total: complete ? total : null, complete, letter: complete ? letter(total) : null };
  });
  const done = rows.filter((r) => r.complete);
  const average = done.length ? Math.round((done.reduce((s, r) => s + r.total, 0) / done.length) * 10) / 10 : null;
  const att = attendanceStats(data.attendance, studentId);
  return { student: st, cls, term, rows, average, letter: average == null ? null : letter(average), final: rows.length > 0 && done.length === rows.length, att, remark: data.remarks[`${studentId}.${term}`] || null };
}

// ---------- operations ----------
const roleName = (r) => ({ admin: 'Admin', teacher: 'Teacher', accountant: 'Accountant', parent: 'Parent' })[r];
export function applyOp(state, op, ctx) {
  const { user, now } = ctx, today = dayKey(now);
  switch (op.type) {
    case 'addUser': {
      need(user, 'admin');
      const role = op.role; if (!['teacher', 'accountant', 'parent'].includes(role)) bad('Choose teacher, accountant or parent');
      const name = clean(op.name, 60); if (name.length < 2) bad('Enter a name');
      const pin = String(op.pin || ''); if (!/^\d{4}$/.test(pin)) bad('PIN must be 4 digits');
      if (state.users.some((u) => u.pin === pin)) bad('That PIN is already used');
      const u = { id: nextId(state, 'u'), name, nameAr: clean(op.nameAr, 60) || name, role, pin, phone: clean(op.phone, 20) };
      state.users.push(u); audit(state, user, now, 'user.add', `${roleName(role)} ${name}`);
      return { id: u.id };
    }
    case 'addStudent': {
      need(user, 'admin');
      const name = clean(op.name, 60); if (name.length < 2) bad('Enter the student name');
      const cls = byId(state.classes, op.classId); if (!cls) bad('Choose a class');
      const g = byId(state.users, op.parentId); if (!g || g.role !== 'parent') bad('Choose a guardian account');
      if (!validDate(String(op.dob || ''))) bad('Enter the date of birth as YYYY-MM-DD');
      const age = daysBetween(op.dob, today) / 365.25; if (age < 2 || age > 14) bad('Date of birth is outside the 2 to 14 year range');
      if (activeIn(state, cls.id).length >= cls.capacity) bad(`${cls.name} is full (${cls.capacity} students)`);
      const s = { id: nextId(state, 's'), code: 'S-' + pad(state.seq.sc = (state.seq.sc || 0) + 1, 4), name, nameAr: clean(op.nameAr, 60) || name, classId: cls.id, dob: op.dob, parentId: g.id, status: 'active', joined: today };
      state.students.push(s); audit(state, user, now, 'student.add', `${name} to ${cls.name}`);
      return { id: s.id, code: s.code };
    }
    case 'moveClass': {
      need(user, 'admin');
      const s = byId(state.students, op.studentId), cls = byId(state.classes, op.classId);
      if (!s || s.status !== 'active') bad('Student not found'); if (!cls) bad('Choose a class');
      if (s.classId === cls.id) bad('The student is already in that class');
      if (activeIn(state, cls.id).length >= cls.capacity) bad(`${cls.name} is full (${cls.capacity} students)`);
      audit(state, user, now, 'student.move', `${s.name} to ${cls.name}`); s.classId = cls.id; return {};
    }
    case 'withdraw': {
      need(user, 'admin');
      const s = byId(state.students, op.studentId); if (!s || s.status !== 'active') bad('Student not found');
      const reason = clean(op.reason, 100); if (reason.length < 3) bad('Write a reason');
      const pm = paidMap(state); let cancelled = 0;
      for (const c of liveCharges(state, s.id)) {
        if (c.due >= today) { const paid = pm.get(c.id) || 0; cancelled += c.amount - paid; if (paid === 0) c.cancelled = true; else c.amount = paid; }
      }
      s.status = 'withdrawn'; s.withdrawn = { at: now, reason };
      audit(state, user, now, 'student.withdraw', `${s.name}: ${reason}`); return { cancelled };
    }
    case 'assignPlan': {
      need(user, 'accountant', 'admin');
      const s = byId(state.students, op.studentId); if (!s || s.status !== 'active') bad('Student not found');
      const plan = byId(state.plans, op.planId); if (!plan) bad('Choose a fee plan');
      if (liveCharges(state, s.id).length) bad('This student already has a fee plan');
      const cs = planCharges(state, s, plan); state.charges.push(...cs);
      audit(state, user, now, 'fees.plan', `${s.name}: ${plan.name}`); return { charges: cs.length, discount: cs[0].discount > 0 };
    }
    case 'payment': {
      need(user, 'accountant', 'admin');
      const r = addPayment(state, { studentId: op.studentId, amount: op.amount, method: op.method, note: op.note, at: now, by: user.id, byName: user.name, reqId: clean(op.reqId, 40) });
      if (!r.duplicate) audit(state, user, now, 'payment', `${r.payment.no} ${egp(r.payment.amount)} EGP`);
      return { paymentId: r.payment.id, no: r.payment.no, duplicate: r.duplicate };
    }
    case 'voidPayment': {
      need(user, 'admin');
      const p = byId(state.payments, op.paymentId); if (!p) bad('Payment not found');
      if (p.voided) bad('This receipt is already voided');
      const reason = clean(op.reason, 100); if (reason.length < 3) bad('Write a reason');
      p.voided = { by: user.id, byName: user.name, at: now, reason }; audit(state, user, now, 'payment.void', `${p.no}: ${reason}`); return {};
    }
    case 'remind': {
      need(user, 'accountant', 'admin');
      const s = byId(state.students, op.studentId); if (!s) bad('Student not found');
      const f = studentFinance(state, s.id, today); if (!f.overdue) bad('Nothing is overdue for this student');
      const last = state.reminders.filter((x) => x.studentId === s.id).sort((a, b) => b.at - a.at)[0];
      if (last && daysBetween(dayKey(last.at), today) < REMIND_GAP_DAYS) bad(`A reminder was already sent on ${dayKey(last.at)}. Wait ${REMIND_GAP_DAYS} days between reminders`);
      state.reminders.push({ studentId: s.id, at: now, by: user.id, amount: f.overdue });
      const nfAr = new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      state.announcements.push({ id: nextId(state, 'a'), title: 'Fee reminder', body: `${s.name}: ${egp(f.overdue)} EGP is overdue (oldest due date ${f.oldestDue}). Please pay at the school office.`, titleAr: 'تذكير بالمصروفات', bodyAr: `${s.nameAr}: مبلغ ${nfAr.format(f.overdue / 100)} جنيه متأخر (أقدم استحقاق ${f.oldestDue}). برجاء السداد في إدارة المدرسة.`, audience: 'user:' + s.parentId, by: user.id, byName: user.name, at: now, pinned: false, system: true });
      audit(state, user, now, 'fees.remind', `${s.name} ${egp(f.overdue)} EGP`); return { amount: f.overdue };
    }
    case 'markAttendance': {
      need(user, 'teacher', 'admin');
      const cls = byId(state.classes, op.classId); if (!cls) bad('Class not found');
      if (user.role === 'teacher' && cls.teacher !== user.id) bad('Only the class teacher can take attendance');
      if (!validDate(String(op.date || '')) || !isSchoolDay(op.date)) bad('Pick a school day (Sunday to Thursday)');
      if (!canMarkDate(user, now, op.date)) bad(user.role === 'teacher' ? 'Teachers can take attendance for the current school day and the one before it' : 'That date is out of range');
      const kids = activeIn(state, cls.id), marks = op.marks || {};
      for (const k of kids) if (!ATT.includes(marks[k.id])) bad(`Mark every student (${k.name} is missing)`);
      if (Object.keys(marks).length !== kids.length) bad('Marks include a student who is not in this class');
      const rec = state.attendance.find((r) => r.date === op.date && r.classId === cls.id);
      const clone = Object.fromEntries(kids.map((k) => [k.id, marks[k.id]]));
      if (rec) { rec.marks = clone; rec.by = user.id; rec.updatedAt = now; } else state.attendance.push({ date: op.date, classId: cls.id, marks: clone, by: user.id, at: now });
      audit(state, user, now, 'attendance', `${cls.name} ${op.date}`);
      return { absent: Object.values(clone).filter((m) => m === 'A').length };
    }
    case 'setScores': {
      need(user, 'teacher', 'admin');
      const cls = byId(state.classes, op.classId), sub = byId(state.subjects, op.subjectId);
      if (!cls || !sub || !cls.subjects.includes(sub.id)) bad('Pick a class and one of its subjects');
      if (!canGrade(state, user, cls.id, sub.id)) bad('You do not teach this subject in this class');
      if (!TERMS.includes(op.term)) bad('Pick term 1 or 2'); if (!(op.kind in KINDS)) bad('Pick coursework, midterm or final');
      const max = KINDS[op.kind], kids = activeIn(state, cls.id), out = [];
      for (const [sid, raw] of Object.entries(op.scores || {})) {
        if (!kids.some((k) => k.id === sid)) bad('A score is for a student who is not in this class');
        if (raw === '' || raw === null) { out.push([sid, null]); continue; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > max) bad(`Scores for ${op.kind} must be between 0 and ${max}`);
        if (Math.round(v * 2) !== v * 2) bad('Use whole or half marks');
        out.push([sid, v]);
      }
      for (const [sid, v] of out) { const key = scoreKey(sid, sub.id, op.term, op.kind); if (v === null) delete state.scores[key]; else state.scores[key] = { v, by: user.id, at: now }; }
      audit(state, user, now, 'grades', `${cls.name} ${sub.name} T${op.term} ${op.kind}`); return { saved: out.length };
    }
    case 'setRemark': {
      need(user, 'teacher', 'admin');
      const s = byId(state.students, op.studentId); if (!s || s.status !== 'active') bad('Student not found');
      const cls = byId(state.classes, s.classId);
      if (user.role === 'teacher' && cls.teacher !== user.id) bad('Only the class teacher writes the report card comment');
      if (!TERMS.includes(op.term)) bad('Pick term 1 or 2');
      const text = clean(op.text, 200), key = `${s.id}.${op.term}`;
      if (text) state.remarks[key] = { text, by: user.id, byName: user.name, at: now }; else delete state.remarks[key];
      return {};
    }
    case 'postAnnouncement': {
      need(user, 'admin', 'teacher');
      const title = clean(op.title, 80), body = clean(op.body, 600); if (!title || !body) bad('Write a title and a message');
      const aud = String(op.audience || '');
      if (user.role === 'teacher') { const m = /^class:(.+)$/.exec(aud); if (!m || !byId(state.classes, m[1]) || !teachesIn(state, user.id, m[1])) bad('Teachers can only write to their own classes'); }
      else if (!(['all', 'parents', 'teachers'].includes(aud) || (/^class:(.+)$/.test(aud) && byId(state.classes, aud.slice(6))))) bad('Choose who should see this');
      state.announcements.push({ id: nextId(state, 'a'), title, body, titleAr: title, bodyAr: body, audience: aud, by: user.id, byName: user.name, at: now, pinned: user.role === 'admin' && !!op.pinned });
      return {};
    }
    case 'deleteAnnouncement': {
      need(user, 'admin', 'teacher');
      const a = byId(state.announcements, op.id); if (!a) bad('Message not found');
      if (user.role !== 'admin' && a.by !== user.id) bad('You can only delete your own messages');
      state.announcements = state.announcements.filter((x) => x.id !== a.id); return {};
    }
    case 'setSlot': {
      need(user, 'admin');
      const cls = byId(state.classes, op.classId), sub = byId(state.subjects, op.subjectId), t = byId(state.users, op.teacherId);
      if (!cls || !sub || !t || t.role !== 'teacher') bad('Pick a class, a subject and a teacher');
      if (!cls.subjects.includes(sub.id)) bad(`${sub.name} is not taught in ${cls.name}`);
      if (!isInt(op.day) || op.day < 0 || op.day > 4 || !isInt(op.period) || op.period < 1 || op.period > PERIODS) bad('Pick a day (Sunday to Thursday) and a period');
      const clash = state.slots.find((x) => x.day === op.day && x.period === op.period && x.teacherId === t.id && x.classId !== cls.id);
      if (clash) bad(`${t.name} already teaches ${byId(state.classes, clash.classId).name} in that period`);
      const cur = state.slots.find((x) => x.classId === cls.id && x.day === op.day && x.period === op.period);
      if (cur) { cur.subjectId = sub.id; cur.teacherId = t.id; } else state.slots.push({ id: nextId(state, 't'), classId: cls.id, day: op.day, period: op.period, subjectId: sub.id, teacherId: t.id });
      return {};
    }
    case 'clearSlot': {
      need(user, 'admin');
      const n = state.slots.length; state.slots = state.slots.filter((x) => !(x.classId === op.classId && x.day === op.day && x.period === op.period));
      if (state.slots.length === n) bad('That period is already empty'); return {};
    }
    default: bad('Unknown action');
  }
}

// ---------- what each role may see ----------
const pub = (u) => ({ id: u.id, name: u.name, nameAr: u.nameAr, role: u.role, phone: u.phone });
export function announcementsFor(state, user) {
  const kidsClasses = user.role === 'parent' ? guardianKids(state, user.id).map((s) => s.classId) : [];
  const mine = user.role === 'teacher' ? myClassIds(state, user) : [];
  const ok = (a) => {
    if (user.role === 'admin') return !a.audience.startsWith('user:');
    if (a.audience === 'all') return true;
    if (a.audience.startsWith('user:')) return a.audience === 'user:' + user.id || (user.role === 'accountant' && a.by === user.id);
    if (a.audience === 'parents') return user.role === 'parent';
    if (a.audience === 'teachers') return user.role === 'teacher';
    if (a.audience.startsWith('class:')) { const c = a.audience.slice(6); return kidsClasses.includes(c) || mine.includes(c) || a.by === user.id; }
    return false;
  };
  return state.announcements.filter(ok).sort((a, b) => (b.pinned - a.pinned) || b.at - a.at);
}
export function view(state, user0, now) {
  const user = byId(state.users, user0.id) || user0;
  const today = dayKey(now), cur = currentSchoolDay(now), role = user.role;
  const out = { now, today, schoolDay: isSchoolDay(today), currentSchoolDay: cur, me: pub(user), school: state.school, subjects: state.subjects, plans: state.plans, resetAt: state.resetAt };
  const teachersOf = state.users.filter((u) => u.role === 'teacher').map((u) => (role === 'admin' || role === 'teacher' ? pub(u) : { ...pub(u), phone: undefined }));
  const kidsOf = (cid) => activeIn(state, cid).length;
  const cls = (c) => ({ ...c, count: kidsOf(c.id) });
  out.announcements = announcementsFor(state, user);
  out.teachers = teachersOf;
  let students, classes = state.classes;
  if (role === 'parent') { students = guardianKids(state, user.id); const cids = new Set(students.map((s) => s.classId)); classes = classes.filter((c) => cids.has(c.id)); }
  else if (role === 'teacher') { const ids = new Set(myClassIds(state, user)); students = state.students.filter((s) => ids.has(s.classId) && s.status === 'active'); classes = classes.filter((c) => ids.has(c.id)); }
  else students = state.students;
  out.classes = classes.map(cls);
  if (role === 'admin' || role === 'accountant') out.allClasses = state.classes.map(cls);
  const sids = new Set(students.map((s) => s.id));
  const parents = new Map(state.users.filter((u) => u.role === 'parent').map((u) => [u.id, u]));
  const pm = paidMap(state);
  out.students = students.map((s) => {
    const g = parents.get(s.parentId); const row = { ...s, guardian: role === 'parent' ? undefined : g && { name: g.name, nameAr: g.nameAr, phone: g.phone } };
    if (role === 'admin' || role === 'accountant' || role === 'parent') row.fin = studentFinance(state, s.id, today, pm);
    return row;
  });
  if (role === 'admin' || role === 'accountant') { out.finance = financeSummary(state, now); out.reminders = state.reminders; }
  if (role === 'admin' || role === 'accountant' || role === 'parent') {
    out.charges = state.charges.filter((c) => sids.has(c.studentId) && !c.cancelled).map((c) => ({ ...c, paid: pm.get(c.id) || 0 }));
    out.payments = state.payments.filter((p) => sids.has(p.studentId)).sort((a, b) => b.at - a.at);
  }
  if (role === 'admin' || role === 'teacher' || role === 'parent') {
    const own = new Set(role === 'teacher' ? classes.filter((c) => c.teacher === user.id).map((c) => c.id) : []);
    out.attendance = state.attendance.filter((r) => role !== 'teacher' || own.has(r.classId)).map((r) => (role === 'parent' ? { ...r, marks: Object.fromEntries(Object.entries(r.marks).filter(([k]) => sids.has(k))) } : r)).filter((r) => Object.keys(r.marks).length);
    out.scores = {}; out.remarks = {};
    for (const [k, e] of Object.entries(state.scores)) {
      const [sid, sub] = k.split('.'); if (!sids.has(sid) && role !== 'admin') continue;
      if (role === 'teacher') { const st = byId(state.students, sid); if (!canGrade(state, user, st.classId, sub)) continue; }
      out.scores[k] = e;
    }
    for (const [k, r] of Object.entries(state.remarks)) if (role === 'admin' || sids.has(k.split('.')[0])) out.remarks[k] = r;
    if (role === 'teacher') out.gradeable = state.classes.flatMap((c) => c.subjects.filter((s) => canGrade(state, user, c.id, s)).map((s) => ({ classId: c.id, subjectId: s })));
  }
  const slotClasses = new Set(role === 'admin' || role === 'accountant' ? state.classes.map((c) => c.id) : classes.map((c) => c.id));
  out.slots = state.slots.filter((x) => slotClasses.has(x.classId));
  if (role === 'admin') { out.users = state.users.map(pub); out.audit = state.audit.slice(-60).reverse(); out.parents = state.users.filter((u) => u.role === 'parent').map(pub); }
  return out;
}

// ---------- CSV ----------
const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
export function overdueCsv(v) {
  const sName = (id) => v.students.find((s) => s.id === id);
  return toCsv([['Student code', 'Student', 'Class', 'Guardian', 'Guardian phone', 'Overdue EGP', 'Oldest due date', 'Days late'], ...v.finance.overdueStudents.map((o) => { const s = sName(o.studentId); const c = v.allClasses.find((x) => x.id === s.classId); return [s.code, s.name, c.name, s.guardian?.name, s.guardian?.phone, egp(o.overdue), o.oldestDue, o.daysLate]; })]);
}
export function paymentsCsv(v) {
  return toCsv([['Receipt', 'Date', 'Student', 'Amount EGP', 'Method', 'Taken by', 'Status'], ...v.payments.slice().reverse().map((p) => [p.no, dayKey(p.at), v.students.find((s) => s.id === p.studentId)?.name, egp(p.amount), p.method, p.byName, p.voided ? 'VOIDED: ' + p.voided.reason : 'ok'])]);
}

// ---------- demo data (made-up school, fictional people) ----------
export const DEMO_USERS = [
  { pin: '1111', role: 'admin', label: 'Principal Laila Haddad', labelAr: 'مديرة المدرسة ليلى حداد' },
  { pin: '2222', role: 'teacher', label: 'Teacher Salma Adel (Grade 2-A)', labelAr: 'المعلمة سلمى عادل (الصف الثاني أ)' },
  { pin: '3333', role: 'accountant', label: 'Accountant Karim Nabil', labelAr: 'المحاسب كريم نبيل' },
  { pin: '4444', role: 'parent', label: 'Parent Dina Farouk (2 children)', labelAr: 'ولي الأمر دينا فاروق (طفلان)' },
];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const GIRLS = [['Yara', 'يارا'], ['Salma', 'سلمى'], ['Mariam', 'مريم'], ['Lina', 'لينا'], ['Nour', 'نور'], ['Farah', 'فرح'], ['Jana', 'جنى'], ['Malak', 'ملك'], ['Hana', 'هنا'], ['Judy', 'جودي'], ['Rodina', 'رودينا'], ['Habiba', 'حبيبة']];
const BOYS = [['Adam', 'آدم'], ['Omar', 'عمر'], ['Youssef', 'يوسف'], ['Ziad', 'زياد'], ['Karim', 'كريم'], ['Hamza', 'حمزة'], ['Mostafa', 'مصطفى'], ['Ali', 'علي'], ['Seif', 'سيف'], ['Tamim', 'تميم'], ['Malek', 'مالك'], ['Hassan', 'حسن']];
const FAMILIES = [['Farouk', 'فاروق'], ['Mansour', 'منصور'], ['Hassan', 'حسن'], ['Saber', 'صابر'], ['Fathy', 'فتحي'], ['Ibrahim', 'إبراهيم'], ['Gamal', 'جمال'], ['Shawky', 'شوقي'], ['Zaki', 'زكي'], ['Abdelaziz', 'عبد العزيز'], ['Mahfouz', 'محفوظ'], ['Rashad', 'رشاد'], ['Attia', 'عطية'], ['Naguib', 'نجيب'], ['Salem', 'سالم'], ['Khattab', 'خطاب'], ['Moussa', 'موسى'], ['Ragab', 'رجب']];
const PARENT_FIRST = [['Dina', 'دينا'], ['Hala', 'هالة'], ['Amr', 'عمرو'], ['Mona', 'منى'], ['Tarek', 'طارق'], ['Rasha', 'رشا'], ['Wael', 'وائل'], ['Noha', 'نهى'], ['Sherif', 'شريف'], ['Heba', 'هبة'], ['Hossam', 'حسام'], ['Ghada', 'غادة']];

export function seed(now = Date.now()) {
  const R = rng(20261125), today = dayKey(now), cur = currentSchoolDay(now);
  const state = { seq: {}, resetAt: now, school: { name: 'Al Nour International School', nameAr: 'مدرسة النور الدولية', year: '2026/2027' }, users: [], classes: [], subjects: [], students: [], plans: [], charges: [], payments: [], attendance: [], scores: {}, remarks: {}, announcements: [], slots: [], reminders: [], audit: [] };
  const pins = new Set(DEMO_USERS.map((d) => d.pin));
  const freshPin = () => { let p; do p = String(1000 + Math.floor(R() * 9000)); while (pins.has(p)); pins.add(p); return p; };
  const U = (role, name, nameAr, pin, phone) => { const u = { id: nextId(state, 'u'), name, nameAr, role, pin, phone }; state.users.push(u); return u; };
  const ph = () => '+2010' + String(10000000 + Math.floor(R() * 89999999));
  U('admin', 'Laila Haddad', 'ليلى حداد', '1111', '+201000000001');
  const acct = U('accountant', 'Karim Nabil', 'كريم نبيل', '3333', '+201000000002');
  const T = {};
  [['reemKG1', 'Reem Said', 'ريم سعيد'], ['hebaKG2', 'Heba Samir', 'هبة سمير'], ['mariam1', 'Mariam Kamal', 'مريم كمال'], ['salma2', 'Salma Adel', 'سلمى عادل'], ['nour3', 'Nour Fathy', 'نور فتحي'], ['dalia4', 'Dalia Ragab', 'داليا رجب'], ['enKG', 'Sara Wagdy', 'سارة وجدي'], ['enP', 'Omar Khalil', 'عمر خليل'], ['sci', 'Tamer Anwar', 'تامر أنور'], ['rel', 'Yusuf Hamed', 'يوسف حامد'], ['art', 'Ahmed Lotfy', 'أحمد لطفي']]
    .forEach(([k, n, a]) => { T[k] = U('teacher', n, a, k === 'salma2' ? '2222' : freshPin(), ph()); });
  const SUB = { ar: ['Arabic', 'اللغة العربية'], en: ['English', 'اللغة الإنجليزية'], math: ['Math', 'الرياضيات'], sci: ['Science', 'العلوم'], soc: ['Social Studies', 'الدراسات الاجتماعية'], rel: ['Religion', 'التربية الدينية'], art: ['Art & PE', 'الفنون والرياضة'], disc: ['Play & Discovery', 'اللعب والاكتشاف'] };
  for (const [k, [n, a]] of Object.entries(SUB)) state.subjects.push({ id: k, name: n, nameAr: a });
  const KG = ['ar', 'en', 'math', 'art', 'disc'], PR = ['ar', 'en', 'math', 'sci', 'soc', 'rel', 'art'];
  const CL = [['KG1-A', 'KG1 - أ', 'KG1', 'reemKG1', KG, 16], ['KG2-A', 'KG2 - أ', 'KG2', 'hebaKG2', KG, 16], ['Grade 1-A', 'الصف الأول - أ', 'Grade 1', 'mariam1', PR, 22], ['Grade 2-A', 'الصف الثاني - أ', 'Grade 2', 'salma2', PR, 22], ['Grade 3-A', 'الصف الثالث - أ', 'Grade 3', 'nour3', PR, 24], ['Grade 4-A', 'الصف الرابع - أ', 'Grade 4', 'dalia4', PR, 24]];
  CL.forEach(([n, a, g, t, subs, cap], i) => state.classes.push({ id: 'c' + (i + 1), name: n, nameAr: a, grade: g, teacher: T[t].id, subjects: subs, capacity: cap, room: 'R' + (101 + i) }));

  // timetable: 25 periods per class, no teacher in two rooms at once
  const teacherFor = (ci, sub) => ({ ar: T[CL[ci][3]], math: T[CL[ci][3]], soc: T[CL[ci][3]], disc: T[CL[ci][3]], art: ci < 2 ? T[CL[ci][3]] : T.art, en: ci < 2 ? T.enKG : T.enP, sci: T.sci, rel: T.rel })[sub];
  const WEEK = { KG: { ar: 5, en: 5, math: 5, art: 5, disc: 5 }, PR: { ar: 5, math: 5, en: 4, sci: 3, soc: 2, rel: 2, art: 4 } };
  // greedy fill with seeded retries: biggest remaining subject first, specialists never in two rooms at once
  const build = (seedN) => {
    const Q = rng(seedN), busy = new Set(), slots = [];
    for (let ci = 0; ci < CL.length; ci++) {
      const left = { ...(ci < 2 ? WEEK.KG : WEEK.PR) };
      for (let p = 1; p <= PERIODS; p++) for (let d = 0; d < 5; d++) {
        const used = slots.filter((x) => x.classId === 'c' + (ci + 1) && x.day === d).map((x) => x.subjectId);
        const order = Object.keys(left).filter((s) => left[s] > 0 && !busy.has(`${teacherFor(ci, s).id}.${d}.${p}`)).map((s) => [s, (used.includes(s) ? 100 : 0) - left[s] + Q() * 3]).sort((a, b) => a[1] - b[1]);
        if (!order.length) return null;
        const pick = order[0][0]; busy.add(`${teacherFor(ci, pick).id}.${d}.${p}`); left[pick]--;
        slots.push({ classId: 'c' + (ci + 1), day: d, period: p, subjectId: pick, teacherId: teacherFor(ci, pick).id });
      }
    }
    return slots;
  };
  let built = null; for (let n = 1; n < 500 && !built; n++) built = build(n);
  if (!built) throw new Error('timetable seed failed');
  for (const x of built) state.slots.push({ id: nextId(state, 't'), ...x });

  // fee plans, due dates relative to "today" so the demo always has paid, overdue and upcoming installments
  const D = (n) => addDays(today, n);
  state.plans.push({ id: 'pl-kg', name: 'Nursery (KG) yearly', nameAr: 'الحضانة (KG) سنوي', total: 1800000, installments: [{ label: 'Installment 1', labelAr: 'القسط الأول', pct: 40, due: D(-75) }, { label: 'Installment 2', labelAr: 'القسط الثاني', pct: 30, due: D(-15) }, { label: 'Installment 3', labelAr: 'القسط الثالث', pct: 30, due: D(50) }] });
  state.plans.push({ id: 'pl-p1', name: 'Primary lower (Grades 1-2) yearly', nameAr: 'ابتدائي أول (الصف الأول والثاني) سنوي', total: 3000000, installments: [{ label: 'Installment 1', labelAr: 'القسط الأول', pct: 30, due: D(-75) }, { label: 'Installment 2', labelAr: 'القسط الثاني', pct: 25, due: D(-40) }, { label: 'Installment 3', labelAr: 'القسط الثالث', pct: 25, due: D(20) }, { label: 'Installment 4', labelAr: 'القسط الرابع', pct: 20, due: D(80) }] });
  state.plans.push({ id: 'pl-p2', name: 'Primary upper (Grades 3-4) yearly', nameAr: 'ابتدائي ثان (الصف الثالث والرابع) سنوي', total: 3400000, installments: [{ label: 'Installment 1', labelAr: 'القسط الأول', pct: 30, due: D(-75) }, { label: 'Installment 2', labelAr: 'القسط الثاني', pct: 25, due: D(-40) }, { label: 'Installment 3', labelAr: 'القسط الثالث', pct: 25, due: D(20) }, { label: 'Installment 4', labelAr: 'القسط الرابع', pct: 20, due: D(80) }] });

  // guardians and students
  const guardians = [];
  for (let g = 0; g < 54; g++) {
    const fam = g === 12 ? FAMILIES[0] : FAMILIES[g % FAMILIES.length], pf = g === 12 ? PARENT_FIRST[0] : PARENT_FIRST[(g * 5 + 1) % PARENT_FIRST.length];
    guardians.push(g === 12 ? U('parent', `${pf[0]} ${fam[0]}`, `${pf[1]} ${fam[1]}`, '4444', ph()) : U('parent', `${pf[0]} ${fam[0]}`, `${pf[1]} ${fam[1]}`, freshPin(), ph()));
  }
  const ageYears = [4, 5, 6, 7, 8, 9];
  for (let i = 0; i < 72; i++) {
    const ci = Math.floor(i / 12), g = guardians[i % 54], gi = i % 54;
    const fam = gi === 12 ? FAMILIES[0] : FAMILIES[gi % FAMILIES.length];
    const girl = i % 2 === 0, pool = girl ? GIRLS : BOYS;
    let nm = pool[(i * 7 + ci) % pool.length];
    if (gi === 12) nm = i === 12 ? ['Yara', 'يارا'] : ['Adam', 'آدم'];
    for (let k = 1; gi !== 12 && (state.students.some((x) => x.name === `${nm[0]} ${fam[0]}`) || ['Yara Farouk', 'Adam Farouk'].includes(`${nm[0]} ${fam[0]}`)); k++) nm = pool[(i * 7 + ci + k) % pool.length];
    const yr = ageYears[ci], dob = D(-Math.round((yr + 0.2 + R() * 0.7) * 365));
    const s = { id: nextId(state, 's'), code: 'S-' + pad(state.seq.sc = (state.seq.sc || 0) + 1, 4), name: `${nm[0]} ${fam[0]}`, nameAr: `${nm[1]} ${fam[1]}`, classId: 'c' + (ci + 1), dob, parentId: g.id, status: 'active', joined: D(-80) };
    state.students.push(s);
  }
  // fee charges and payments
  const planOf = (cid) => (cid <= 'c2' ? 'pl-kg' : cid <= 'c4' ? 'pl-p1' : 'pl-p2');
  for (const s of state.students) {
    const plan = byId(state.plans, planOf(s.classId)); const cs = planCharges(state, s, plan); state.charges.push(...cs);
    cs.forEach((c, i) => {
      if (c.due >= today) return;
      const r = R(), p = i === 0 ? 0.94 : 0.8;
      if (s.parentId === guardians[12].id) {
        if (i === 0) addPayment(state, { studentId: s.id, amount: c.amount, method: 'transfer', note: '', at: Date.parse(`${addDays(c.due, 3)}T09:30:00Z`), by: acct.id, byName: acct.name });
        else if (s.classId === 'c6') addPayment(state, { studentId: s.id, amount: Math.round(c.amount / 2 / 100) * 100, method: 'card', note: 'Part payment', at: Date.parse(`${addDays(c.due, 5)}T10:00:00Z`), by: acct.id, byName: acct.name });
        return;
      }
      if (r < p) addPayment(state, { studentId: s.id, amount: c.amount, method: ['cash', 'card', 'transfer'][Math.floor(R() * 3)], note: '', at: Date.parse(`${addDays(c.due, Math.min(Math.floor(R() * 12), daysBetween(c.due, today)))}T09:30:00Z`), by: acct.id, byName: acct.name });
      else if (r < p + 0.08) addPayment(state, { studentId: s.id, amount: Math.round(c.amount / 2 / 100) * 100, method: 'cash', note: 'Part payment', at: Date.parse(`${addDays(c.due, Math.min(4, daysBetween(c.due, today)))}T10:15:00Z`), by: acct.id, byName: acct.name });
    });
  }
  // the demo parent: first installments paid, second overdue (so the portal shows both)
  // attendance for the last 22 school days; the current day is left open for Grade 2-A and KG2-A
  let d = cur; const days = [];
  for (let n = 0; n < 22; n++) { days.push(d); d = prevSchoolDay(d); }
  for (const day of days) for (const c of state.classes) {
    if (day === cur && (c.id === 'c4' || c.id === 'c2')) continue;
    const marks = {}; for (const s of activeIn(state, c.id)) { const r = R(); marks[s.id] = r < 0.9 ? 'P' : r < 0.95 ? 'A' : r < 0.98 ? 'L' : 'E'; }
    state.attendance.push({ date: day, classId: c.id, marks, by: c.teacher, at: Date.parse(day + 'T06:30:00Z') });
  }
  // grades: term 1 complete for every subject, term 2 coursework only
  for (const s of state.students) {
    let ability = 0.55 + R() * 0.4; if (s.parentId === guardians[12].id) ability = 0.84 + R() * 0.06; const cls = byId(state.classes, s.classId);
    for (const sub of cls.subjects) for (const term of TERMS) for (const [kind, max] of Object.entries(KINDS)) {
      if (term === 2 && kind !== 'work') continue;
      const v = Math.min(max, Math.max(0, Math.round((max * (ability + (R() - 0.5) * 0.25)) * 2) / 2));
      state.scores[scoreKey(s.id, sub, term, kind)] = { v, by: cls.teacher, at: now - 86400000 * (term === 1 ? 30 : 5) };
    }
  }
  const [s12, s66] = state.students.filter((x) => x.parentId === guardians[12].id);
  {
    state.remarks[`${s12.id}.1`] = { text: 'Curious and kind. Reads with confidence. Keep practising letter shapes at home.', textAr: 'فضولية ولطيفة. تقرأ بثقة. يُرجى التدرّب على أشكال الحروف في المنزل.', by: T.hebaKG2.id, byName: T.hebaKG2.name, at: now - 86400000 * 29 };
    state.remarks[`${s66.id}.1`] = { text: 'Careful worker. Should join in class discussion more often.', textAr: 'يعمل بعناية. يُنصح بالمشاركة في النقاش داخل الفصل أكثر.', by: T.dalia4.id, byName: T.dalia4.name, at: now - 86400000 * 29 };
  }
  const A = (title, titleAr, body, bodyAr, audience, by, pinned, ago) => state.announcements.push({ id: nextId(state, 'a'), title, titleAr, body, bodyAr, audience, by: by.id, byName: by.name, at: now - ago * 3600000, pinned });
  const principal = state.users[0];
  A('Welcome to the new school year', 'أهلاً بكم في العام الدراسي الجديد', 'Classes run Sunday to Thursday, 8:00 to 14:00. The school gate opens at 7:30. Please bring a signed health card on the first day.', 'الدراسة من الأحد إلى الخميس، من 8:00 إلى 14:00. تفتح البوابة 7:30 صباحاً. برجاء إحضار الكارت الصحي موقعاً في أول يوم.', 'all', principal, true, 900);
  A('Parents meeting', 'اجتماع أولياء الأمور', 'Term 1 results meeting for all parents. Each class teacher will be at the classroom door. No booking needed.', 'اجتماع نتائج الفصل الدراسي الأول لجميع أولياء الأمور. سيكون معلم كل فصل عند باب الفصل. لا حاجة للحجز.', 'parents', principal, false, 60);
  A('Staff meeting', 'اجتماع المعلمين', 'Term 2 planning, Thursday after the last period. Bring your term 1 mark sheets.', 'تخطيط الفصل الثاني، الخميس بعد الحصة الأخيرة. أحضروا كشوف درجات الفصل الأول.', 'teachers', principal, false, 40);
  A('Grade 2-A trip to the science museum', 'رحلة الصف الثاني أ إلى متحف العلوم', 'Our trip is planned for next Tuesday. Please send the signed permission slip with your child. Lunch is provided.', 'رحلتنا يوم الثلاثاء القادم. برجاء إرسال إذن الرحلة موقعاً مع طفلكم. الغداء مقدم من المدرسة.', 'class:c4', T.salma2, false, 20);
  A('Uniform reminder', 'تذكير بالزي المدرسي', 'Winter uniform starts next week. The school shop is open from 9:00 to 13:00.', 'يبدأ الزي الشتوي الأسبوع القادم. متجر المدرسة مفتوح من 9:00 إلى 13:00.', 'all', principal, false, 8);
  return state;
}

// keeps the stored file small: drop old audit rows and cap lists
export function compact(state) { if (state.audit.length > 200) state.audit = state.audit.slice(-200); }

import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/logic.js';
import { signToken, readToken } from '../api/_auth.js';

const NOW = Date.parse('2026-11-25T12:00:00Z'); // a Wednesday in Cairo
const FRI = Date.parse('2026-11-27T10:00:00Z');
const fresh = (now = NOW) => { const s = L.seed(now); return { s, now, u: (pin) => s.users.find((x) => x.pin === pin), admin: s.users.find((x) => x.pin === '1111'), teacher: s.users.find((x) => x.pin === '2222'), acct: s.users.find((x) => x.pin === '3333'), parent: s.users.find((x) => x.pin === '4444') }; };
const run = (t, user, op, now = t.now) => L.applyOp(t.s, op, { user, now });
const fails = (fn, re) => assert.throws(fn, (e) => e instanceof L.UserError && (!re || re.test(e.message)));
const sumCents = (a) => a.reduce((x, y) => x + y, 0);

test('calendar: school week is Sunday to Thursday in Cairo', () => {
  assert.equal(L.dayKey(NOW), '2026-11-25');
  assert.equal(L.isSchoolDay('2026-11-25'), true);
  assert.equal(L.isSchoolDay('2026-11-26'), true); // Thursday
  assert.equal(L.isSchoolDay('2026-11-27'), false); // Friday
  assert.equal(L.isSchoolDay('2026-11-28'), false);
  assert.equal(L.isSchoolDay('2026-11-29'), true); // Sunday
  assert.equal(L.currentSchoolDay(FRI), '2026-11-26');
  assert.equal(L.currentSchoolDay(Date.parse('2026-11-28T09:00:00Z')), '2026-11-26');
  assert.equal(L.prevSchoolDay('2026-11-29'), '2026-11-26');
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.daysBetween('2026-11-01', '2026-11-25'), 24);
  // just after midnight in Cairo is already the next day
  assert.equal(L.dayKey(Date.parse('2026-11-25T22:30:00Z')), '2026-11-26');
});

test('seed: ids, PINs, classes and capacity are consistent', () => {
  const { s } = fresh();
  const uniq = (a) => new Set(a).size === a.length;
  assert.ok(uniq(s.users.map((u) => u.id)) && uniq(s.users.map((u) => u.pin)) && uniq(s.students.map((x) => x.id)) && uniq(s.students.map((x) => x.code)));
  assert.ok(s.users.every((u) => /^\d{4}$/.test(u.pin)));
  for (const c of s.classes) { assert.ok(L.activeIn(s, c.id).length <= c.capacity, c.name); assert.equal(s.users.find((u) => u.id === c.teacher).role, 'teacher'); }
  for (const st of s.students) { assert.ok(s.classes.some((c) => c.id === st.classId)); assert.equal(s.users.find((u) => u.id === st.parentId).role, 'parent'); }
  assert.equal(s.students.length, 72);
  assert.equal(new Set(s.students.map((x) => x.name)).size, 72, 'student names are unique');
  assert.equal(new Set(s.students.map((x) => x.nameAr)).size, 72);
  assert.equal(L.guardianKids(s, fresh().parent.id).length, 2);
});

test('seed: timetable is full and no teacher is in two classes at once', () => {
  const { s } = fresh();
  for (const c of s.classes) {
    const mine = s.slots.filter((x) => x.classId === c.id);
    assert.equal(mine.length, 25, c.name);
    assert.ok(mine.every((x) => c.subjects.includes(x.subjectId)));
    assert.equal(new Set(mine.map((x) => x.day + '.' + x.period)).size, 25);
  }
  const seen = new Set();
  for (const x of s.slots) { const k = `${x.teacherId}.${x.day}.${x.period}`; assert.ok(!seen.has(k), 'double booked ' + k); seen.add(k); }
});

test('seed: money is consistent, nobody owes a negative amount or pays more than billed', () => {
  const { s } = fresh();
  const pm = L.paidMap(s);
  for (const c of s.charges) { assert.ok(c.amount > 0 && c.amount === c.gross - c.discount); assert.ok((pm.get(c.id) || 0) <= c.amount, c.id); }
  for (const p of s.payments) assert.equal(sumCents(p.allocs.map((a) => a.amount)), p.amount);
  for (const plan of s.plans) { assert.equal(sumCents(plan.installments.map((i) => i.pct)), 100); assert.equal(sumCents(L.splitPlan(plan.total, plan.installments)), plan.total); }
  const f = L.financeSummary(s, NOW);
  assert.equal(f.billed - f.collected, f.outstanding);
  assert.equal(f.collected, sumCents(s.payments.filter((p) => !p.voided).map((p) => p.amount)));
  const per = s.students.map((st) => L.studentFinance(s, st.id, '2026-11-25', pm));
  assert.equal(sumCents(per.map((x) => x.overdue)), f.overdue);
  assert.equal(sumCents(per.map((x) => x.balance)), f.outstanding);
  assert.equal(f.aging.d30 + f.aging.d60 + f.aging.d61, f.overdue);
  assert.ok(f.overdue > 0 && f.upcoming30 > 0 && f.collected > 0);
});

test('seed: scores are within their maximums, term 2 has only coursework', () => {
  const { s } = fresh();
  for (const [k, e] of Object.entries(s.scores)) { const [, , term, kind] = k.split('.'); assert.ok(e.v >= 0 && e.v <= L.KINDS[kind], k); assert.ok(Math.round(e.v * 2) === e.v * 2); if (term === '2') assert.equal(kind, 'work'); }
});

test('split plan: odd totals still add up exactly and the last installment absorbs rounding', () => {
  const a = L.splitPlan(100001, [{ pct: 33 }, { pct: 33 }, { pct: 34 }]);
  assert.equal(sumCents(a), 100001);
  assert.equal(a[0], 33000);
});

test('sibling discount: the second child with a plan gets 10% off every installment, the first does not', () => {
  const t = fresh(); const kids = L.guardianKids(t.s, t.parent.id);
  const [a, b] = kids.map((k) => L.liveCharges(t.s, k.id));
  assert.ok(a.every((c) => c.discount === 0));
  assert.ok(b.every((c) => c.discount === Math.round((c.gross * L.SIBLING_PCT) / 100) && c.amount < c.gross));
  // a brand new child of a guardian who already has a student with a plan
  const id = run(t, t.admin, { type: 'addStudent', name: 'Nada Test', classId: 'c3', dob: '2019-05-01', parentId: t.parent.id }).id;
  const r = run(t, t.acct, { type: 'assignPlan', studentId: id, planId: 'pl-p1' });
  assert.equal(r.discount, true);
  fails(() => run(t, t.acct, { type: 'assignPlan', studentId: id, planId: 'pl-p1' }), /already has a fee plan/);
  // a guardian with one child gets no discount
  const solo = fresh(); const g = solo.s.users.find((u) => u.role === 'parent' && L.guardianKids(solo.s, u.id).length === 1);
  const nid = run(solo, solo.admin, { type: 'addUser', role: 'parent', name: 'New Parent', pin: '9999' }).id;
  const sid = run(solo, solo.admin, { type: 'addStudent', name: 'Solo Kid', classId: 'c3', dob: '2019-05-01', parentId: nid }).id;
  assert.equal(run(solo, solo.acct, { type: 'assignPlan', studentId: sid, planId: 'pl-p1' }).discount, false);
  assert.ok(g);
});

test('payment: takes oldest installment first and spreads across installments', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id); // KG2: inst 1 paid, inst 2 overdue 5,400.00
  const before = L.chargeRows(t.s, yara.id, '2026-11-25');
  const inst2 = before.find((r) => r.label === 'Installment 2'), inst3 = before.find((r) => r.label === 'Installment 3');
  assert.equal(inst2.balance, 540000);
  const r = run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 600000, method: 'cash', reqId: 'r1' });
  const after = L.chargeRows(t.s, yara.id, '2026-11-25');
  assert.equal(after.find((x) => x.id === inst2.id).balance, 0);
  assert.equal(after.find((x) => x.id === inst3.id).balance, inst3.balance - 60000);
  assert.equal(L.studentFinance(t.s, yara.id, '2026-11-25').overdue, 0);
  assert.match(r.no, /^RC-\d{6}$/);
});

test('payment: refuses zero, negative, fractional, too large and unknown method', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id); const f = L.studentFinance(t.s, yara.id, '2026-11-25');
  for (const amount of [0, -100, 10.5, NaN, '500', null]) fails(() => run(t, t.acct, { type: 'payment', studentId: yara.id, amount, method: 'cash' }));
  fails(() => run(t, t.acct, { type: 'payment', studentId: yara.id, amount: f.balance + 1, method: 'cash' }), /more than what is owed/);
  fails(() => run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 100, method: 'bitcoin' }), /cash, card or transfer/);
  fails(() => run(t, t.acct, { type: 'payment', studentId: 'nope', amount: 100, method: 'cash' }), /Student not found/);
  assert.equal(L.studentFinance(t.s, yara.id, '2026-11-25').balance, f.balance);
  run(t, t.acct, { type: 'payment', studentId: yara.id, amount: f.balance, method: 'card' }); // paying exactly everything is allowed
  assert.equal(L.studentFinance(t.s, yara.id, '2026-11-25').balance, 0);
  fails(() => run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 100, method: 'cash' }), /more than what is owed/);
});

test('payment: the same request id never charges twice, receipt numbers go up by one', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id); const n0 = t.s.payments.length;
  const a = run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 10000, method: 'cash', reqId: 'same' });
  const b = run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 10000, method: 'cash', reqId: 'same' });
  assert.equal(b.duplicate, true); assert.equal(a.no, b.no); assert.equal(t.s.payments.length, n0 + 1);
  const c = run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 10000, method: 'cash', reqId: 'other' });
  assert.equal(Number(c.no.slice(3)), Number(a.no.slice(3)) + 1);
});

test('payment: only accountant and admin can take or void money', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id);
  for (const u of [t.teacher, t.parent]) fails(() => run(t, u, { type: 'payment', studentId: yara.id, amount: 100, method: 'cash' }), /permission/);
  const r = run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 100000, method: 'cash' });
  fails(() => run(t, t.acct, { type: 'voidPayment', paymentId: r.paymentId, reason: 'mistake' }), /permission/);
  fails(() => run(t, t.admin, { type: 'voidPayment', paymentId: r.paymentId, reason: '' }), /reason/);
  const before = L.studentFinance(t.s, yara.id, '2026-11-25').balance;
  run(t, t.admin, { type: 'voidPayment', paymentId: r.paymentId, reason: 'Entered on the wrong student' });
  assert.equal(L.studentFinance(t.s, yara.id, '2026-11-25').balance, before + 100000);
  fails(() => run(t, t.admin, { type: 'voidPayment', paymentId: r.paymentId, reason: 'again' }), /already voided/);
  assert.equal(L.financeSummary(t.s, NOW).collected, sumCents(t.s.payments.filter((p) => !p.voided).map((p) => p.amount)));
});

test('withdraw: unpaid future installments are cancelled, overdue ones stay, part-paid ones are cut to what was paid', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id);
  run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 540000 + 100000, method: 'cash' }); // clears overdue and pays 1,000.00 of installment 3
  const r = run(t, t.admin, { type: 'withdraw', studentId: yara.id, reason: 'Moved to another city' });
  const rows = L.chargeRows(t.s, yara.id, '2026-11-25');
  assert.equal(rows.length, 3);
  const inst3 = rows.find((x) => x.label === 'Installment 3'); assert.equal(inst3.amount, 100000); assert.equal(inst3.balance, 0);
  assert.equal(r.cancelled, 540000 - 100000);
  assert.equal(L.byId(t.s.students, yara.id).status, 'withdrawn');
  assert.equal(L.activeIn(t.s, yara.classId).some((x) => x.id === yara.id), false);
  const [, adam] = [0, L.guardianKids(t.s, t.parent.id)[1]];
  const owed = L.studentFinance(t.s, adam.id, '2026-11-25').overdue;
  run(t, t.admin, { type: 'withdraw', studentId: adam.id, reason: 'Left the school' });
  assert.equal(L.studentFinance(t.s, adam.id, '2026-11-25').overdue, owed); // the debt is still there
  assert.ok(L.liveCharges(t.s, adam.id).every((c) => c.due < '2026-11-25'));
  fails(() => run(t, t.teacher, { type: 'withdraw', studentId: adam.id, reason: 'x yz' }), /permission/);
  fails(() => run(t, t.admin, { type: 'withdraw', studentId: adam.id, reason: 'again' }), /not found/);
});

test('reminders: only when something is overdue, once per 7 days, reach only that guardian', () => {
  const t = fresh(); const [yara] = L.guardianKids(t.s, t.parent.id);
  run(t, t.acct, { type: 'remind', studentId: yara.id });
  fails(() => run(t, t.acct, { type: 'remind', studentId: yara.id }), /already sent/);
  const eight = NOW + 8 * 864e5;
  run(t, t.acct, { type: 'remind', studentId: yara.id }, eight);
  const mine = L.announcementsFor(t.s, t.parent).filter((a) => a.system);
  assert.equal(mine.length, 2);
  const other = t.s.users.find((u) => u.role === 'parent' && u.id !== t.parent.id);
  assert.equal(L.announcementsFor(t.s, other).filter((a) => a.system).length, 0);
  assert.equal(L.announcementsFor(t.s, t.teacher).filter((a) => a.system).length, 0);
  run(t, t.acct, { type: 'payment', studentId: yara.id, amount: 540000, method: 'cash' }, eight + 1);
  fails(() => run(t, t.acct, { type: 'remind', studentId: yara.id }, eight + 15 * 864e5 + 2), /Nothing is overdue|already|Wait/);
  fails(() => run(t, t.teacher, { type: 'remind', studentId: yara.id }), /permission/);
});

test('attendance: class teacher only, complete marks only, valid window only', () => {
  const t = fresh(); const c4 = L.byId(t.s.classes, 'c4'), kids = L.activeIn(t.s, 'c4');
  const all = (code) => Object.fromEntries(kids.map((k) => [k.id, code]));
  assert.equal(L.attendanceStats(t.s.attendance.filter((r) => r.classId === 'c4'), kids[0].id).days, 21); // today is still open
  const r = run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: { ...all('P'), [kids[0].id]: 'A', [kids[1].id]: 'L' } });
  assert.equal(r.absent, 1);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c3', date: '2026-11-25', marks: {} }), /class teacher/);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: { ...all('P'), [kids[2].id]: undefined } }), /Mark every/);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: { ...all('P'), [kids[2].id]: 'X' } }), /Mark every/);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: { ...all('P'), zzz: 'P' } }), /not in this class/);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-26', marks: all('P') }), /current school day/); // tomorrow
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-20', marks: all('P') }), /Pick a school day/); // a Friday
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-22', marks: all('P') }), /current school day/); // too old for a teacher
  fails(() => run(t, t.parent, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: all('P') }), /permission/);
  // editing the same day replaces, it does not duplicate
  const n = t.s.attendance.length;
  run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: all('P') });
  assert.equal(t.s.attendance.length, n);
  assert.equal(t.s.attendance.find((x) => x.classId === 'c4' && x.date === '2026-11-25').marks[kids[0].id], 'P');
  // admin can correct an older day, but not a date more than 30 days back or in the future
  run(t, t.admin, { type: 'markAttendance', classId: 'c4', date: '2026-11-22', marks: all('E') });
  fails(() => run(t, t.admin, { type: 'markAttendance', classId: 'c4', date: '2026-10-11', marks: all('P') }), /out of range/);
  fails(() => run(t, t.admin, { type: 'markAttendance', classId: 'c4', date: '2026-11-29', marks: all('P') }), /out of range/);
  assert.equal(c4.teacher, t.teacher.id);
});

test('attendance: on a weekend the teacher window is the last two school days', () => {
  const t = fresh(FRI); const kids = L.activeIn(t.s, 'c4'); const all = Object.fromEntries(kids.map((k) => [k.id, 'P']));
  assert.deepEqual(L.teacherMarkWindow(FRI), ['2026-11-26', '2026-11-25']);
  run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-26', marks: all }, FRI);
  run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: all }, FRI);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-24', marks: all }, FRI), /current school day/);
  fails(() => run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-27', marks: all }, FRI), /school day/);
});

test('attendance: a withdrawn student does not have to be marked, and excused days stay out of the rate', () => {
  const t = fresh(); const kids = L.activeIn(t.s, 'c4');
  run(t, t.admin, { type: 'withdraw', studentId: kids[0].id, reason: 'Moved away' });
  const rest = L.activeIn(t.s, 'c4'); assert.equal(rest.length, kids.length - 1);
  run(t, t.teacher, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: Object.fromEntries(rest.map((k) => [k.id, 'P'])) });
  const recs = [{ marks: { x: 'P' } }, { marks: { x: 'A' } }, { marks: { x: 'L' } }, { marks: { x: 'E' } }, { marks: { x: 'E' } }, { marks: { y: 'A' } }];
  const st = L.attendanceStats(recs, 'x');
  assert.deepEqual([st.P, st.A, st.L, st.E, st.days, st.rate], [1, 1, 1, 2, 5, 67]);
  assert.equal(L.attendanceStats([{ marks: { x: 'E' } }], 'x').rate, null);
});

test('grades: limits, half marks, who may grade what, and all-or-nothing saves', () => {
  const t = fresh(); const kids = L.activeIn(t.s, 'c4'); const sc = (sid, sub, term, kind) => t.s.scores[L.scoreKey(sid, sub, term, kind)];
  const base = { type: 'setScores', classId: 'c4', subjectId: 'math', term: 1, kind: 'mid' };
  run(t, t.teacher, { ...base, scores: { [kids[0].id]: 27.5, [kids[1].id]: 30, [kids[2].id]: 0 } });
  assert.equal(sc(kids[0].id, 'math', 1, 'mid').v, 27.5);
  const was = sc(kids[3].id, 'math', 1, 'mid').v;
  fails(() => run(t, t.teacher, { ...base, scores: { [kids[3].id]: 12, [kids[4].id]: 31 } }), /between 0 and 30/);
  assert.equal(sc(kids[3].id, 'math', 1, 'mid').v, was); // the valid row in the same save was not kept
  fails(() => run(t, t.teacher, { ...base, scores: { [kids[3].id]: -1 } }), /between/);
  fails(() => run(t, t.teacher, { ...base, scores: { [kids[3].id]: 12.3 } }), /half marks/);
  fails(() => run(t, t.teacher, { ...base, scores: { [kids[3].id]: 'abc' } }), /between/);
  fails(() => run(t, t.teacher, { ...base, kind: 'final', scores: { [kids[3].id]: 51 } }), /between 0 and 50/);
  fails(() => run(t, t.teacher, { ...base, term: 3, scores: {} }), /term/);
  fails(() => run(t, t.teacher, { ...base, subjectId: 'disc', scores: {} }), /one of its subjects/); // not in a primary class
  fails(() => run(t, t.teacher, { ...base, classId: 'c3', scores: {} }), /do not teach/);
  fails(() => run(t, t.teacher, { ...base, scores: { [L.activeIn(t.s, 'c3')[0].id]: 5 } }), /not in this class/);
  fails(() => run(t, t.parent, { ...base, scores: { [kids[3].id]: 5 } }), /permission/);
  fails(() => run(t, t.acct, { ...base, scores: { [kids[3].id]: 5 } }), /permission/);
  run(t, t.teacher, { ...base, scores: { [kids[0].id]: '' } }); // clearing
  assert.equal(sc(kids[0].id, 'math', 1, 'mid'), undefined);
  run(t, t.admin, { ...base, classId: 'c3', scores: { [L.activeIn(t.s, 'c3')[0].id]: 20 } });
});

test('grades: a specialist grades only their own subject and sees only those scores', () => {
  const t = fresh(); const sci = t.s.users.find((u) => u.name === 'Tamer Anwar'); const kids = L.activeIn(t.s, 'c4');
  assert.equal(L.canGrade(t.s, sci, 'c4', 'sci'), true);
  assert.equal(L.canGrade(t.s, sci, 'c4', 'math'), false);
  fails(() => run(t, sci, { type: 'setScores', classId: 'c4', subjectId: 'math', term: 1, kind: 'work', scores: { [kids[0].id]: 10 } }), /do not teach/);
  run(t, sci, { type: 'setScores', classId: 'c4', subjectId: 'sci', term: 1, kind: 'work', scores: { [kids[0].id]: 10 } });
  const v = L.view(t.s, sci, NOW);
  assert.ok(Object.keys(v.scores).length > 0 && Object.keys(v.scores).every((k) => k.split('.')[1] === 'sci'));
  assert.deepEqual(v.attendance, []); // not their homeroom
  fails(() => run(t, sci, { type: 'markAttendance', classId: 'c4', date: '2026-11-25', marks: {} }), /class teacher/);
});

test('report card: totals, letter bands, incomplete subjects stay out of the average', () => {
  assert.deepEqual([100, 90, 89.9, 80, 70, 60, 59.5, 0].map(L.letter), ['A', 'A', 'B', 'B', 'C', 'D', 'F', 'F']);
  const t = fresh(); const st = L.guardianKids(t.s, t.parent.id)[1]; // Grade 4
  let rc = L.reportCard(t.s, st.id, 1);
  assert.equal(rc.rows.length, 7); assert.equal(rc.final, true);
  const manual = rc.rows.map((r) => r.parts.work + r.parts.mid + r.parts.final);
  assert.deepEqual(rc.rows.map((r) => r.total), manual);
  assert.equal(rc.average, Math.round((sumCents(manual) / 7) * 10) / 10);
  assert.equal(rc.letter, L.letter(rc.average));
  rc = L.reportCard(t.s, st.id, 2); // term 2 only has coursework
  assert.equal(rc.final, false); assert.equal(rc.average, null); assert.ok(rc.rows.every((r) => !r.complete && r.total === null));
  const teacher = t.s.users.find((u) => u.name === 'Dalia Ragab');
  for (const kind of ['mid', 'final']) run(t, teacher, { type: 'setScores', classId: 'c6', subjectId: 'ar', term: 2, kind, scores: { [st.id]: kind === 'mid' ? 30 : 50 } });
  rc = L.reportCard(t.s, st.id, 2);
  const ar = rc.rows.find((r) => r.subject.id === 'ar');
  assert.equal(ar.complete, true); assert.equal(rc.final, false);
  assert.equal(rc.average, ar.total); // only the finished subject counts
  assert.ok(rc.att.days >= 20 && rc.att.rate > 50);
  assert.equal(L.reportCard(t.s, 'missing', 1), null);
});

test('report card comment: only the class teacher (or admin) can write it', () => {
  const t = fresh(); const kid = L.activeIn(t.s, 'c4')[0], other = L.activeIn(t.s, 'c3')[0];
  run(t, t.teacher, { type: 'setRemark', studentId: kid.id, term: 1, text: '  Great effort this term.  ' });
  assert.equal(t.s.remarks[`${kid.id}.1`].text, 'Great effort this term.');
  fails(() => run(t, t.teacher, { type: 'setRemark', studentId: other.id, term: 1, text: 'hi' }), /class teacher/);
  fails(() => run(t, t.parent, { type: 'setRemark', studentId: kid.id, term: 1, text: 'hi' }), /permission/);
  run(t, t.teacher, { type: 'setRemark', studentId: kid.id, term: 1, text: '' });
  assert.equal(t.s.remarks[`${kid.id}.1`], undefined);
});

test('announcements: audiences, teacher limits, delete rights, pinning', () => {
  const t = fresh();
  fails(() => run(t, t.teacher, { type: 'postAnnouncement', title: 'Hi', body: 'x', audience: 'all' }), /own classes/);
  fails(() => run(t, t.teacher, { type: 'postAnnouncement', title: 'Hi', body: 'x', audience: 'class:c1' }), /own classes/);
  fails(() => run(t, t.teacher, { type: 'postAnnouncement', title: '', body: 'x', audience: 'class:c4' }), /title/);
  fails(() => run(t, t.admin, { type: 'postAnnouncement', title: 'T', body: 'B', audience: 'user:u1' }), /who should see/);
  fails(() => run(t, t.admin, { type: 'postAnnouncement', title: 'T', body: 'B', audience: 'class:zzz' }), /who should see/);
  fails(() => run(t, t.parent, { type: 'postAnnouncement', title: 'T', body: 'B', audience: 'all' }), /permission/);
  run(t, t.teacher, { type: 'postAnnouncement', title: 'Homework', body: 'Pages 4 and 5', audience: 'class:c4', pinned: true });
  run(t, t.admin, { type: 'postAnnouncement', title: 'Teachers only', body: 'Room change', audience: 'teachers' });
  run(t, t.admin, { type: 'postAnnouncement', title: 'Class KG1', body: 'Paint day', audience: 'class:c1' });
  const titles = (u) => L.announcementsFor(t.s, u).map((a) => a.title);
  assert.ok(!titles(t.parent).includes('Homework')); // the demo parent has KG2 and Grade 4, not Grade 2
  assert.ok(!titles(t.parent).includes('Teachers only') && !titles(t.parent).includes('Class KG1'));
  assert.ok(titles(t.teacher).includes('Homework') && titles(t.teacher).includes('Teachers only') && !titles(t.teacher).includes('Class KG1'));
  assert.ok(!titles(t.teacher).includes('Parents meeting'));
  assert.ok(titles(t.acct).includes('Welcome to the new school year') && !titles(t.acct).includes('Homework'));
  const mine = L.announcementsFor(t.s, t.teacher).find((a) => a.title === 'Homework'); assert.equal(mine.pinned, false); // only the admin can pin
  const admins = L.announcementsFor(t.s, t.admin); assert.equal(admins[0].pinned, true);
  const welcome = admins.find((a) => a.title.startsWith('Welcome'));
  fails(() => run(t, t.teacher, { type: 'deleteAnnouncement', id: welcome.id }), /your own/);
  run(t, t.teacher, { type: 'deleteAnnouncement', id: mine.id });
  run(t, t.admin, { type: 'deleteAnnouncement', id: welcome.id });
  fails(() => run(t, t.admin, { type: 'deleteAnnouncement', id: welcome.id }), /not found/);
  const kg2Parent = t.s.users.find((u) => u.id === L.byId(t.s.students, L.activeIn(t.s, 'c2')[0].id).parentId);
  run(t, t.admin, { type: 'postAnnouncement', title: 'KG2 news', body: 'Hello', audience: 'class:c2' });
  assert.ok(titles(kg2Parent).includes('KG2 news'));
});

test('timetable: teacher clashes, wrong subjects and bad slots are refused', () => {
  const t = fresh(); const enP = t.s.users.find((u) => u.name === 'Omar Khalil'), mariam = t.s.users.find((u) => u.name === 'Mariam Kamal');
  const g3 = t.s.slots.find((x) => x.classId === 'c5' && x.teacherId === enP.id);
  const free = t.s.slots.find((x) => x.classId === 'c6' && x.day === g3.day && x.period === g3.period); // Grade 4 at the same time
  fails(() => run(t, t.admin, { type: 'setSlot', classId: 'c6', day: g3.day, period: g3.period, subjectId: 'en', teacherId: enP.id }), /already teaches Grade 3-A/);
  fails(() => run(t, t.admin, { type: 'setSlot', classId: 'c6', day: 0, period: 1, subjectId: 'disc', teacherId: mariam.id }), /not taught/);
  fails(() => run(t, t.admin, { type: 'setSlot', classId: 'c6', day: 5, period: 1, subjectId: 'ar', teacherId: mariam.id }), /Sunday to Thursday/);
  fails(() => run(t, t.admin, { type: 'setSlot', classId: 'c6', day: 0, period: 6, subjectId: 'ar', teacherId: mariam.id }), /period/);
  fails(() => run(t, t.admin, { type: 'setSlot', classId: 'c6', day: 0, period: 1, subjectId: 'ar', teacherId: t.acct.id }), /teacher/);
  fails(() => run(t, t.teacher, { type: 'setSlot', classId: 'c6', day: 0, period: 1, subjectId: 'ar', teacherId: mariam.id }), /permission/);
  assert.ok(free);
  // swapping within the same class slot is allowed and replaces (no duplicate cell)
  const n = t.s.slots.length; const own = t.s.slots.find((x) => x.classId === 'c4');
  run(t, t.admin, { type: 'setSlot', classId: 'c4', day: own.day, period: own.period, subjectId: own.subjectId, teacherId: own.teacherId });
  assert.equal(t.s.slots.length, n);
  run(t, t.admin, { type: 'clearSlot', classId: 'c4', day: own.day, period: own.period });
  assert.equal(t.s.slots.length, n - 1);
  fails(() => run(t, t.admin, { type: 'clearSlot', classId: 'c4', day: own.day, period: own.period }), /empty/);
  run(t, t.admin, { type: 'setSlot', classId: 'c4', day: own.day, period: own.period, subjectId: own.subjectId, teacherId: own.teacherId });
});

test('people: users, students, capacity, moves', () => {
  const t = fresh();
  fails(() => run(t, t.teacher, { type: 'addUser', role: 'parent', name: 'X Y', pin: '5555' }), /permission/);
  fails(() => run(t, t.admin, { type: 'addUser', role: 'admin', name: 'Sneaky', pin: '5555' }), /teacher, accountant or parent/);
  fails(() => run(t, t.admin, { type: 'addUser', role: 'parent', name: 'X Y', pin: '1111' }), /already used/);
  fails(() => run(t, t.admin, { type: 'addUser', role: 'parent', name: 'X Y', pin: '12a4' }), /4 digits/);
  fails(() => run(t, t.admin, { type: 'addUser', role: 'parent', name: ' ', pin: '5555' }), /name/);
  const g = run(t, t.admin, { type: 'addUser', role: 'parent', name: 'Mona\u0000 Adel', phone: '+20 100 123', pin: '5555' }).id;
  assert.equal(L.byId(t.s.users, g).name, 'Mona  Adel');
  fails(() => run(t, t.admin, { type: 'addStudent', name: 'Kid', classId: 'c1', dob: '2022-01-01', parentId: t.teacher.id }), /guardian/);
  fails(() => run(t, t.admin, { type: 'addStudent', name: 'Kid', classId: 'c1', dob: '2026-01-01', parentId: g }), /range/);
  fails(() => run(t, t.admin, { type: 'addStudent', name: 'Kid', classId: 'c1', dob: '2019-02-30', parentId: g }), /YYYY-MM-DD/);
  fails(() => run(t, t.admin, { type: 'addStudent', name: 'Kid', classId: 'zz', dob: '2022-01-01', parentId: g }), /class/);
  const before = t.s.students.length;
  const a = run(t, t.admin, { type: 'addStudent', name: 'Hoda Adel', classId: 'c1', dob: '2022-03-03', parentId: g });
  assert.match(a.code, /^S-\d{4}$/); assert.equal(t.s.students.length, before + 1);
  // fill KG1 (capacity 16) and the next one is refused
  while (L.activeIn(t.s, 'c1').length < 16) run(t, t.admin, { type: 'addStudent', name: 'Filler Kid', classId: 'c1', dob: '2022-03-03', parentId: g });
  fails(() => run(t, t.admin, { type: 'addStudent', name: 'Late Kid', classId: 'c1', dob: '2022-03-03', parentId: g }), /is full/);
  const kid = L.activeIn(t.s, 'c2')[0];
  fails(() => run(t, t.admin, { type: 'moveClass', studentId: kid.id, classId: 'c1' }), /is full/);
  fails(() => run(t, t.admin, { type: 'moveClass', studentId: kid.id, classId: 'c2' }), /already in that class/);
  run(t, t.admin, { type: 'moveClass', studentId: kid.id, classId: 'c3' });
  assert.equal(L.byId(t.s.students, kid.id).classId, 'c3');
  fails(() => L.applyOp(t.s, { type: 'nope' }, { user: t.admin, now: NOW }), /Unknown action/);
});

test('privacy: a parent view holds only their own children, never other families or any PIN', () => {
  const t = fresh(); const v = L.view(t.s, t.parent, NOW); const json = JSON.stringify(v);
  const mine = new Set(L.guardianKids(t.s, t.parent.id).map((s) => s.id));
  assert.deepEqual(new Set(v.students.map((s) => s.id)), mine);
  assert.ok(v.charges.every((c) => mine.has(c.studentId)) && v.payments.every((p) => mine.has(p.studentId)));
  assert.ok(Object.keys(v.scores).every((k) => mine.has(k.split('.')[0])));
  assert.ok(v.attendance.every((r) => Object.keys(r.marks).every((k) => mine.has(k))));
  for (const s of t.s.students) if (!mine.has(s.id)) { assert.ok(!json.includes('"' + s.id + '"'), s.id); }
  assert.ok(!json.includes('"pin"') && !('finance' in v) && !('users' in v) && !('audit' in v));
  for (const u of t.s.users) assert.ok(!json.includes(`"${u.pin}"`) || u.pin === '4444' && false, 'pin leaked');
  assert.ok(v.teachers.every((x) => x.phone === undefined));
  assert.ok(v.students.every((s) => s.guardian === undefined));
  assert.ok(v.classes.every((c) => mine.size && L.guardianKids(t.s, t.parent.id).some((s) => s.classId === c.id)));
});

test('privacy: a teacher sees no fees, an accountant sees no grades or attendance, nobody sees PINs', () => {
  const t = fresh();
  const tv = L.view(t.s, t.teacher, NOW), av = L.view(t.s, t.acct, NOW), adm = L.view(t.s, t.admin, NOW);
  for (const k of ['finance', 'charges', 'payments', 'reminders', 'users']) assert.ok(!(k in tv), 'teacher has ' + k);
  assert.ok(tv.students.every((s) => !('fin' in s) && s.classId === 'c4'));
  for (const k of ['scores', 'attendance', 'remarks', 'users']) assert.ok(!(k in av), 'accountant has ' + k);
  assert.ok('finance' in av && av.students.length === 72);
  for (const v of [tv, av, adm]) assert.ok(!JSON.stringify(v).includes('"pin"'));
  assert.equal(adm.users.length, t.s.users.length);
  assert.ok(adm.attendance.length > 100);
});

test('csv: formulas are neutralised, overdue export lists every overdue student', () => {
  assert.equal(L.toCsv([['=1+1', 'a,b', 'say "hi"']]), '\ufeff"\'=1+1","a,b","say ""hi"""\r\n');
  const t = fresh(); const v = L.view(t.s, t.admin, NOW);
  const csv = L.overdueCsv(v).trim().split('\r\n');
  assert.equal(csv.length - 1, v.finance.overdueStudents.length);
  assert.ok(csv[0].includes('Guardian phone'));
  const pay = L.paymentsCsv(v).trim().split('\r\n'); assert.equal(pay.length - 1, v.payments.length);
});

test('sign-in tokens: round trip, tampering, expiry, deleted user', () => {
  const users = [{ id: 'u1', name: 'A', role: 'admin' }];
  const tok = signToken('u1', 1000);
  assert.deepEqual(readToken(tok, users, 2000), { id: 'u1', name: 'A', role: 'admin' });
  assert.equal(readToken(tok + 'x', users, 2000), null);
  assert.equal(readToken(tok.replace(/^./, 'Z'), users, 2000), null);
  assert.equal(readToken('', users, 2000), null);
  assert.equal(readToken(tok, users, 1000 + 13 * 3600 * 1000), null);
  assert.equal(readToken(tok, [], 2000), null);
  const forged = Buffer.from('u1.' + (Date.now() + 1e9)).toString('base64url') + '.AAAA';
  assert.equal(readToken(forged, users), null);
});

test('hostile text is stored as plain text, trimmed and capped', () => {
  const t = fresh();
  run(t, t.admin, { type: 'postAnnouncement', title: '<img src=x onerror=alert(1)>' + 'x'.repeat(200), body: '<script>alert(1)</script>', audience: 'all' });
  const a = t.s.announcements.at(-1); assert.equal(a.title.length, 80); assert.equal(a.body, '<script>alert(1)</script>'); // the app escapes it when drawing
});

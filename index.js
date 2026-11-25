const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");

initializeApp();

const APP_SCRIPT_URL = defineSecret("APP_SCRIPT_URL");
const APP_SCRIPT_TOKEN = defineSecret("APP_SCRIPT_TOKEN");
const UNIT_EMAIL = defineSecret("UNIT_EMAIL");

exports.deleteRegisteredStudents = onCall({region: "us-central1", timeoutSeconds: 540, memory: "512MiB"}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول.");
  const db = getFirestore();
  const adminDoc = await db.collection("admins").doc(request.auth.uid).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "هذه العملية متاحة للإدارة فقط.");

  const [usersSnap, claimsSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("claims").get()
  ]);
  const uids = new Set(usersSnap.docs.map(d => d.id));
  claimsSnap.docs.forEach(d => {
    const uid = d.data().uid;
    if (uid) uids.add(uid);
  });

  let deleted = 0;
  const ids = [...uids];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const result = await getAuth().deleteUsers(batch).catch(async () => {
      const errors = [];
      for (const uid of batch) {
        try { await getAuth().deleteUser(uid); }
        catch (e) { if (e.code !== "auth/user-not-found") errors.push(uid + ": " + e.message); }
      }
      if (errors.length) throw new Error(errors.join("; "));
      return {successCount: batch.length};
    });
    deleted += result.successCount || 0;
  }

  let batch = db.batch(), count = 0;
  const refs = [...usersSnap.docs.map(d => d.ref), ...claimsSnap.docs.map(d => d.ref)];
  for (const ref of refs) {
    batch.delete(ref);
    count++;
    if (count % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (count % 450) await batch.commit();
  return {ok: true, deleted, recordsRemoved: refs.length};
});


exports.notifyAdvisorOnPrint = onCall({
  region: "us-central1",
  timeoutSeconds: 60,
  secrets: [APP_SCRIPT_URL, APP_SCRIPT_TOKEN, UNIT_EMAIL]
}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول.");
  const db = getFirestore();
  const ref = db.collection("users").doc(request.auth.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "بيانات الطالب غير موجودة.");
  const student = snap.data();
  if (student.status !== "printed" || student.locked !== true) {
    throw new HttpsError("failed-precondition", "يجب اعتماد الاستمارة أولًا.");
  }
  if (student.mailNotifiedAt) return {ok: true, alreadySent: true};
  const [rosterDoc, advisorDoc, catalogDoc] = await Promise.all([
    db.collection("public").doc("roster").get(),
    db.collection("config").doc("advisorsInfo").get(),
    db.collection("config").doc("catalog").get()
  ]);
  const roster = rosterDoc.exists ? JSON.parse(rosterDoc.data().json || "[]") : [];
  const assigned = roster.find(x => Number(x.id) === Number(student.serial));
  const advisorName = assigned?.advisor || student.advisor || "غير موجود";
  const advisors = advisorDoc.exists ? JSON.parse(advisorDoc.data().json || "[]") : [];
  const norm = v => String(v || "").replace(/[\u064B-\u065F\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
  const advisor = advisors.find(x => norm(x.name) === norm(advisorName)) ||
    advisors.find(x => norm(x.name).startsWith(norm(advisorName)) || norm(advisorName).startsWith(norm(x.name)));
  if (!advisor?.email) throw new HttpsError("failed-precondition", "لم يتم العثور على بريد المرشد في ملف المرشدين.");
  const catalog = catalogDoc.exists ? JSON.parse(catalogDoc.data().json || "{}") : {programs: []};
  const choices = (student.choices || []).map(c => ({
    program: catalog.programs?.find(p => p.id === c.program)?.name || c.program || "",
    c1: c.c1 || "", c2: c.c2 || "", c3: c.c3 || ""
  }));
  const printedAt = student.printedAt?.toDate ? student.printedAt.toDate().toLocaleString("ar-EG") : new Date().toLocaleString("ar-EG");
  const payload = {
    action: "notify_student",
    token: APP_SCRIPT_TOKEN.value(),
    unitEmail: UNIT_EMAIL.value(),
    student: {
      serial: student.serial, name: student.name, nid: student.nid, phone: student.phone,
      advisorName, advisorEmail: advisor.email, dept: advisor.dept || "غير محدد",
      choices, printedAt
    }
  };
  const response = await fetch(APP_SCRIPT_URL.value(), {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=utf-8"},
    body: JSON.stringify(payload),
    redirect: "follow"
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new HttpsError("internal", result?.error || "تعذر إرسال إشعار البريد.");
  }
  await ref.update({mailNotifiedAt: require("firebase-admin/firestore").FieldValue.serverTimestamp()});
  return {ok: true};
});

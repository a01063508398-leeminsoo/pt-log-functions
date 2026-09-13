const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

function parseValue(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.data();
  if (!raw || raw.value == null) return null;
  try {
    return JSON.parse(raw.value);
  } catch (e) {
    return null;
  }
}

// Push tokens live in their own documents (pt-push-trainer /
// pt-push-member:{id}) so that registering a token never races with the
// frequent whole-document writes that messages, weight logs and diet logs
// perform on pt-directory / pt-member:{id}.
//
// Entries are { deviceId, token }. Older data may hold bare token strings, so
// both shapes are normalised here.
async function readEntries(docId) {
  const snap = await db.collection("pt-log-data").doc(docId).get();
  const parsed = parseValue(snap);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => (typeof e === "string" ? { deviceId: null, token: e } : e))
    .filter((e) => e && e.token);
}

// FCM rejects tokens from uninstalled apps / cleared browsers. Drop those so
// the list doesn't fill up with dead entries over time.
async function pruneEntries(docId, entries, responses) {
  const deadIdx = new Set();
  responses.forEach((r, i) => {
    const code = r.error?.code || "";
    if (
      !r.success &&
      (code.includes("registration-token-not-registered") || code.includes("invalid-argument"))
    ) {
      deadIdx.add(i);
    }
  });
  if (deadIdx.size === 0) return;
  const alive = entries.filter((_, i) => !deadIdx.has(i));
  try {
    await db
      .collection("pt-log-data")
      .doc(docId)
      .set({ value: JSON.stringify(alive), updatedAt: Date.now() }, { merge: true });
    console.log(`정리됨 - ${docId}에서 만료 토큰 ${deadIdx.size}개 제거`);
  } catch (e) {
    console.error("token prune failed", docId, e);
  }
}

async function sendToTokens(docId, title, body) {
  // FCM rejects a notification with an empty body ("messaging/invalid-payload"),
  // and some feed entries arrive without usable text, so fall back to a generic
  // line rather than losing the notification entirely.
  const safeTitle = (title && String(title).trim()) || "민수PTLOG";
  const safeBody = (body && String(body).trim()) || "새로운 소식이 있어요";

  const entries = await readEntries(docId);
  console.log(`발송 시도 ${docId} - 기기 수: ${entries.length}`);
  if (entries.length === 0) return;
  try {
    const res = await messaging.sendEachForMulticast({
      tokens: entries.map((e) => e.token),
      notification: { title: safeTitle, body: safeBody },
    });
    console.log(`발송 결과 - 성공: ${res.successCount}, 실패: ${res.failureCount}`);
    res.responses.forEach((r, i) => {
      if (!r.success) console.error(`토큰[${i}] 실패:`, r.error?.code, r.error?.message);
    });
    await pruneEntries(docId, entries, res.responses);
  } catch (e) {
    console.error("push send failed", e);
  }
}

// Notification lists are capped with .slice(0, 200) on the client, so once the
// cap is reached a new entry no longer changes the array length. Comparing the
// newest entry's id instead keeps detection working at any list size.
function newestIfAdded(beforeList, afterList) {
  const after = afterList || [];
  if (after.length === 0) return null;
  const newest = after[0];
  if (!newest || !newest.id) return null;
  const beforeIds = new Set((beforeList || []).map((n) => n && n.id).filter(Boolean));
  return beforeIds.has(newest.id) ? null : newest;
}

exports.onPtLogDataWrite = onDocumentWritten("pt-log-data/{docId}", async (event) => {
  const docId = event.params.docId;
  const before = parseValue(event.data.before);
  const after = parseValue(event.data.after);
  if (!after) return;

  // Trainer-facing activity feed. Every member action the trainer should hear
  // about — including messages — lands here, so this is the single source of
  // trainer pushes.
  if (docId === "pt-directory") {
    const newest = newestIfAdded(before?.trainerNotifications, after.trainerNotifications);
    if (newest) {
      await sendToTokens("pt-push-trainer", "민수PTLOG", newest.text);
    }
    return;
  }

  // Member-facing notifications. The client writes a notifications entry for
  // trainer messages as well as for comments and other activity, so pushing
  // only from this list avoids the duplicate that came from also pushing on
  // the messages array growing.
  if (docId.startsWith("pt-member:")) {
    const memberId = docId.slice("pt-member:".length);
    const newest = newestIfAdded(before?.notifications, after.notifications);
    if (newest) {
      await sendToTokens(`pt-push-member:${memberId}`, "민수PTLOG", newest.text);
    }
  }
});

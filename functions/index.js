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
// pt-push-member:{id}) so registering a token never races with the frequent
// whole-document writes that messages, weight logs and diet logs perform on
// pt-directory / pt-member:{id}.
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
  // FCM rejects a notification with an empty body, and some feed entries
  // arrive without usable text, so fall back to a generic line rather than
  // losing the notification entirely.
  const safeTitle = (title && String(title).trim()) || "민수PTLOG";
  const safeBody = (body && String(body).trim()) || "새로운 소식이 있어요";

  const entries = await readEntries(docId);
  console.log(`발송 시도 ${docId} - 기기 수: ${entries.length} - 내용: ${safeBody}`);
  if (entries.length === 0) return;
  try {
    const res = await messaging.sendEachForMulticast({
      tokens: entries.map((e) => e.token),
      // Data-only on purpose. With a `notification` block the browser displays
      // the alert itself AND the service worker's onBackgroundMessage fires and
      // calls showNotification, so every push appeared twice. Sending data only
      // leaves the service worker as the single place that displays anything.
      data: { title: safeTitle, body: safeBody },
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

// Detecting "something new was added" has to survive three things the client
// does: notifications are prepended (newest first) while messages are appended
// (newest last); the notification list is capped with .slice(0, 200) so at the
// cap the length stops growing; and some entries may lack an id.
//
// Comparing id sets handles order and the cap correctly. When ids aren't
// usable we fall back to a length check, taking the entry from whichever end
// is newest for that list.
function findNewEntries(beforeList, afterList, newestFirst) {
  const before = Array.isArray(beforeList) ? beforeList : [];
  const after = Array.isArray(afterList) ? afterList : [];
  if (after.length === 0) return [];

  const afterHasIds = after.every((n) => n && n.id);
  const beforeHasIds = before.every((n) => n && n.id);

  if (afterHasIds && beforeHasIds) {
    const beforeIds = new Set(before.map((n) => n.id));
    const added = after.filter((n) => !beforeIds.has(n.id));
    if (added.length > 0) return added;
    // Ids all matched: genuinely nothing new (e.g. a read-flag update).
    return [];
  }

  if (after.length > before.length) {
    return [newestFirst ? after[0] : after[after.length - 1]];
  }
  return [];
}

exports.onPtLogDataWrite = onDocumentWritten("pt-log-data/{docId}", async (event) => {
  const docId = event.params.docId;
  const before = parseValue(event.data.before);
  const after = parseValue(event.data.after);
  if (!after) return;

  // Trainer-facing activity feed. Every member action the trainer should hear
  // about — messages, routines, weight, diet — lands here.
  if (docId === "pt-directory") {
    const added = findNewEntries(before?.trainerNotifications, after.trainerNotifications, true);
    for (const n of added.slice(0, 3)) {
      await sendToTokens("pt-push-trainer", "민수PTLOG", n.text);
    }
    return;
  }

  if (docId.startsWith("pt-member:")) {
    const memberId = docId.slice("pt-member:".length);
    const pushDoc = `pt-push-member:${memberId}`;

    // Member-facing notifications cover trainer messages as well as comments
    // and other trainer activity, so this is the primary source.
    const addedNotifs = findNewEntries(before?.notifications, after.notifications, true);
    for (const n of addedNotifs.slice(0, 3)) {
      await sendToTokens(pushDoc, "민수PTLOG", n.text);
    }

    // Safety net: if a trainer message somehow lands without a matching
    // notification entry, push it from the messages array instead. Skipping
    // this when a notification was already sent is what prevents the duplicate
    // "트레이너 메시지" + "민수PTLOG" pair users were seeing.
    if (addedNotifs.length === 0) {
      const addedMsgs = findNewEntries(before?.messages, after.messages, false);
      const lastTrainerMsg = addedMsgs.filter((m) => m && m.from === "trainer").pop();
      if (lastTrainerMsg) {
        await sendToTokens(pushDoc, "민수PTLOG", `트레이너가 메시지를 보냈어요: "${lastTrainerMsg.text}"`);
      }
    }
  }
});


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

async function sendToTokens(tokens, title, body) {
  const list = (tokens || []).filter(Boolean);
  if (list.length === 0) return;
  try {
    await messaging.sendEachForMulticast({
      tokens: list,
      notification: { title, body },
    });
  } catch (e) {
    console.error("push send failed", e);
  }
}

exports.onPtLogDataWrite = onDocumentWritten("pt-log-data/{docId}", async (event) => {
  const docId = event.params.docId;
  const before = parseValue(event.data.before);
  const after = parseValue(event.data.after);
  if (!after) return;

  if (docId === "pt-directory") {
    const beforeCount = before?.trainerNotifications?.length || 0;
    const afterList = after.trainerNotifications || [];
    if (afterList.length > beforeCount) {
      const newest = afterList[0];
      await sendToTokens(after.trainerPushTokens, "민수PTLOG", newest.text);
    }
    return;
  }

  if (docId.startsWith("pt-member:")) {
    const beforeMsgs = before?.messages || [];
    const afterMsgs = after.messages || [];
    if (afterMsgs.length > beforeMsgs.length) {
      const last = afterMsgs[afterMsgs.length - 1];
      if (last.from === "member") {
        const dirSnap = await db.collection("pt-log-data").doc("pt-directory").get();
        const dir = parseValue(dirSnap);
        await sendToTokens(dir?.trainerPushTokens, "새 메시지", last.text);
      } else if (last.from === "trainer") {
        await sendToTokens(after.pushTokens, "트레이너 메시지", last.text);
      }
    }

    const beforeNotifs = before?.notifications?.length || 0;
    const afterNotifsList = after.notifications || [];
    if (afterNotifsList.length > beforeNotifs) {
      const newest = afterNotifsList[0];
      await sendToTokens(after.pushTokens, "민수PTLOG", newest.text);
    }
  }
});

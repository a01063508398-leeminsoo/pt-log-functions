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

// Push tokens now live in their own documents (pt-push-trainer /
// pt-push-member:{id}) instead of inside pt-directory / pt-member:{id}, so
// that registering a token never races with (and gets overwritten by) the
// frequent whole-document writes those docs receive from messages, weight
// logs, diet logs, etc.
async function readTokens(docId) {
  const snap = await db.collection("pt-log-data").doc(docId).get();
  const parsed = parseValue(snap);
  return Array.isArray(parsed) ? parsed : [];
}

// FCM rejects tokens that belong to uninstalled apps / cleared browsers. Drop
// those so the list doesn't fill up with dead entries over time.
async function pruneTokens(docId, tokens, responses) {
  const dead = [];
  responses.forEach((r, i) => {
    const code = r.error?.code || "";
    if (!r.success && (code.includes("registration-token-not-registered") || code.includes("invalid-argument"))) {
      dead.push(tokens[i]);
    }
  });
  if (dead.length === 0) return;
  const alive = tokens.filter((t) => !dead.includes(t));
  try {
    await db.collection("pt-log-data").doc(docId).set(
      { value: JSON.stringify(alive), updatedAt: Date.now() },
      { merge: true }
    );
    console.log(`pruned ${dead.length} dead token(s) from ${docId}`);
  } catch (e) {
    console.error("token prune failed", docId, e);
  }
}

async function sendToTokens(docId, title, body) {
  const tokens = (await readTokens(docId)).filter(Boolean);
  console.log(`sendToTokens ${docId} - 토큰 수: ${tokens.length}`);
  if (tokens.length === 0) return;
  try {
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
    });
    console.log(`발송 결과 - 성공: ${res.successCount}, 실패: ${res.failureCount}`);
    res.responses.forEach((r, i) => {
      if (!r.success) console.error(`토큰[${i}] 실패:`, r.error?.code, r.error?.message);
    });
    await pruneTokens(docId, tokens, res.responses);
  } catch (e) {
    console.error("push send failed", e);
  }
}

exports.onPtLogDataWrite = onDocumentWritten("pt-log-data/{docId}", async (event) => {
  const docId = event.params.docId;
  console.log(`[진단] 함수 진입 - docId: ${docId}`);

  const before = parseValue(event.data.before);
  const after = parseValue(event.data.after);
  console.log(`[진단] before 파싱: ${before ? "성공" : "null"}, after 파싱: ${after ? "성공" : "null"}`);
  if (!after) {
    console.log("[진단] after가 null이라 종료");
    return;
  }

  if (docId === "pt-directory") {
    const beforeCount = before?.trainerNotifications?.length || 0;
    const afterList = after.trainerNotifications || [];
    console.log(`[진단] pt-directory - 알림 전: ${beforeCount}, 후: ${afterList.length}`);
    if (afterList.length > beforeCount) {
      const newest = afterList[0];
      await sendToTokens("pt-push-trainer", "민수PTLOG", newest.text);
    }
    return;
  }

  if (docId.startsWith("pt-member:")) {
    const memberId = docId.slice("pt-member:".length);
    const memberPushDoc = `pt-push-member:${memberId}`;
    const beforeMsgs = before?.messages || [];
    const afterMsgs = after.messages || [];
    console.log(`[진단] pt-member - memberId: ${memberId}, 메시지 전: ${beforeMsgs.length}, 후: ${afterMsgs.length}`);

    if (afterMsgs.length > beforeMsgs.length) {
      const last = afterMsgs[afterMsgs.length - 1];
      console.log(`[진단] 새 메시지 감지 - from: ${last.from}, text: ${last.text}`);
      if (last.from === "member") {
        await sendToTokens("pt-push-trainer", "새 메시지", last.text);
      } else if (last.from === "trainer") {
        await sendToTokens(memberPushDoc, "트레이너 메시지", last.text);
      } else {
        console.log(`[진단] from 값이 member/trainer 둘 다 아님: ${last.from}`);
      }
    } else {
      console.log("[진단] 메시지 개수 증가 없음");
    }

    const beforeNotifs = before?.notifications?.length || 0;
    const afterNotifsList = after.notifications || [];
    console.log(`[진단] 알림 전: ${beforeNotifs}, 후: ${afterNotifsList.length}`);
    if (afterNotifsList.length > beforeNotifs) {
      const newest = afterNotifsList[0];
      await sendToTokens(memberPushDoc, "민수PTLOG", newest.text);
    }
    return;
  }

  console.log(`[진단] pt-member:도 pt-directory도 아닌 문서 - 처리 안 함`);
});

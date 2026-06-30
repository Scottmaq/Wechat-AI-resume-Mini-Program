const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const COLLECTIONS = {
  results: "resume_results",
  users: "users"
};
const UNLOCK_PRICE_FEN = 399;
const PRO_CREDITS_PER_PURCHASE = 3;

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || "";
    const resultId = String(event.resultId || "").trim();

    if (!openid) return { ok: false, message: "无法识别微信用户身份。" };
    if (!resultId) return { ok: false, message: "缺少结果ID。" };

    const resultDoc = await db.collection(COLLECTIONS.results).doc(resultId).get();
    const record = resultDoc.data;
    if (!record || record._openid !== openid) {
      return { ok: false, message: "没有权限查看这份简历结果。" };
    }

    const user = await getUser(openid);
    return {
      ok: true,
      data: buildResultResponse(record, {
        creditsRemaining: user ? Number(user.proAnalysisCredits || 0) : 0
      })
    };
  } catch (error) {
    console.error("getResult failed", error);
    return {
      ok: false,
      message: error.message || "获取结果失败，请稍后再试。"
    };
  }
};

async function getUser(openid) {
  const res = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  return res.data && res.data[0] ? res.data[0] : null;
}

function buildResultResponse(record, extra) {
  const base = record.unlocked ? record.fullResult : record.freeResult;
  return {
    ...base,
    resultId: record._id,
    targetRole: record.targetRole,
    score: record.score,
    summary: record.summary,
    isUnlocked: !!record.unlocked,
    demoMode: !!record.demoMode,
    priceFen: UNLOCK_PRICE_FEN,
    unlockPriceText: "3.99",
    proCreditsIncluded: PRO_CREDITS_PER_PURCHASE,
    creditsRemaining: extra.creditsRemaining,
    createdAt: record.createdAt
  };
}

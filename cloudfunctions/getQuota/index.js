const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const COLLECTIONS = {
  users: "users"
};

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || "";
    if (!openid) return { ok: false, message: "无法识别微信用户身份。" };

    const user = await getOrCreateUser(openid);
    return {
      ok: true,
      data: buildQuota(user)
    };
  } catch (error) {
    console.error("getQuota failed", error);
    return {
      ok: false,
      message: error.message || "获取额度失败。"
    };
  }
};

async function getOrCreateUser(openid) {
  const res = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  if (res.data && res.data[0]) return res.data[0];

  const user = {
    _openid: openid,
    freeAnalysisUsed: false,
    proAnalysisCredits: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const created = await db.collection(COLLECTIONS.users).add({ data: user });
  return {
    ...user,
    _id: created._id
  };
}

function buildQuota(user) {
  const freeRemaining = user.freeAnalysisUsed ? 0 : 1;
  const proRemaining = Number(user.proAnalysisCredits || 0);
  return {
    freeRemaining,
    proRemaining,
    totalRemaining: freeRemaining + proRemaining,
    freeAnalysisUsed: !!user.freeAnalysisUsed
  };
}

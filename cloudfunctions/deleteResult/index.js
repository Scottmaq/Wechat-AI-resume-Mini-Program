const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const COLLECTIONS = {
  results: "resume_results"
};

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || "";
    const resultId = String(event.resultId || "").trim();

    if (!openid) return { ok: false, message: "无法识别微信用户身份。" };
    if (!resultId) return { ok: false, message: "缺少结果ID。" };

    const doc = await db.collection(COLLECTIONS.results).doc(resultId).get();
    const record = doc.data;
    if (!record || record._openid !== openid) {
      return { ok: false, message: "没有权限删除这份简历结果。" };
    }

    const fileID = record.fullResult && record.fullResult.pdfFileID;
    if (fileID) {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
      } catch (error) {
        console.warn("delete pdf file failed", error);
      }
    }

    await db.collection(COLLECTIONS.results).doc(resultId).remove();
    return { ok: true };
  } catch (error) {
    console.error("deleteResult failed", error);
    return {
      ok: false,
      message: error.message || "删除失败，请稍后再试。"
    };
  }
};

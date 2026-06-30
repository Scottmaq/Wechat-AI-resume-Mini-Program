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
      return { ok: false, message: "没有权限下载这份PDF。" };
    }
    if (!record.unlocked) {
      return { ok: false, message: "请先解锁完整简历后再下载PDF。" };
    }

    const fileID = record.fullResult && record.fullResult.pdfFileID;
    if (!fileID) {
      return { ok: false, message: record.fullResult && record.fullResult.pdfNotice ? record.fullResult.pdfNotice : "当前结果没有生成PDF文件。" };
    }

    const temp = await cloud.getTempFileURL({
      fileList: [fileID]
    });
    const item = temp.fileList && temp.fileList[0] ? temp.fileList[0] : null;
    if (!item || item.status !== 0 || !item.tempFileURL) {
      return {
        ok: false,
        message: item && item.errMsg ? item.errMsg : "获取PDF下载链接失败，请检查云存储文件是否存在。"
      };
    }

    return {
      ok: true,
      tempFileURL: item.tempFileURL
    };
  } catch (error) {
    console.error("getPdfUrl failed", error);
    return {
      ok: false,
      message: error.message || "获取PDF下载链接失败。"
    };
  }
};

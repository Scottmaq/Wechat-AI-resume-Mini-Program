const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const COLLECTIONS = {
  orders: "orders",
  results: "resume_results",
  users: "users",
  entitlements: "entitlements"
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
    const result = resultDoc.data;
    if (!result || result._openid !== openid) {
      return { ok: false, message: "没有权限解锁这份简历。" };
    }
    if (result.unlocked) {
      return { ok: true, alreadyUnlocked: true, message: "这份简历已解锁。" };
    }

    const outTradeNo = buildOutTradeNo();
    await db.collection(COLLECTIONS.orders).add({
      data: {
        _openid: openid,
        resultId,
        outTradeNo,
        amountFen: UNLOCK_PRICE_FEN,
        status: "PENDING",
        productName: "完整简历解锁包",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    if (process.env.ENABLE_MOCK_PAY === "true") {
      await markOrderPaid(outTradeNo, {
        transactionId: `mock_${Date.now()}`
      });
      return {
        ok: true,
        mockPaid: true,
        outTradeNo,
        message: "模拟支付成功，已解锁当前简历。"
      };
    }

    if (!cloud.cloudPay || !cloud.cloudPay.unifiedOrder) {
      return {
        ok: false,
        message: "当前云函数环境不支持 cloud.cloudPay.unifiedOrder，请确认已开通云开发微信支付能力。"
      };
    }

    const subMchId = process.env.WECHAT_PAY_SUB_MCH_ID || process.env.WECHAT_PAY_MCH_ID || "";
    if (!subMchId) {
      return {
        ok: false,
        message: "缺少微信支付商户号环境变量 WECHAT_PAY_SUB_MCH_ID。"
      };
    }

    const payment = await cloud.cloudPay.unifiedOrder({
      body: "AI简历优化-完整简历解锁包",
      outTradeNo,
      spbillCreateIp: "127.0.0.1",
      subMchId,
      totalFee: UNLOCK_PRICE_FEN,
      envId: process.env.TCB_ENV || wxContext.ENV || "",
      functionName: "payNotify",
      tradeType: "JSAPI"
    });

    return {
      ok: true,
      outTradeNo,
      payment
    };
  } catch (error) {
    console.error("createOrder failed", error);
    return {
      ok: false,
      message: error.message || "创建支付订单失败。"
    };
  }
};

function buildOutTradeNo() {
  return `resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function markOrderPaid(outTradeNo, payInfo) {
  const orderRes = await db.collection(COLLECTIONS.orders).where({ outTradeNo }).limit(1).get();
  const order = orderRes.data && orderRes.data[0] ? orderRes.data[0] : null;
  if (!order) throw new Error("订单不存在。");
  if (order.status === "PAID") return;

  await db.collection(COLLECTIONS.orders).doc(order._id).update({
    data: {
      status: "PAID",
      transactionId: payInfo.transactionId || "",
      paidAt: new Date(),
      updatedAt: new Date()
    }
  });
  await db.collection(COLLECTIONS.results).doc(order.resultId).update({
    data: {
      unlocked: true,
      unlockedAt: new Date(),
      updatedAt: new Date()
    }
  });
  await db.collection(COLLECTIONS.users).where({ _openid: order._openid }).update({
    data: {
      proAnalysisCredits: _.inc(PRO_CREDITS_PER_PURCHASE),
      updatedAt: new Date()
    }
  });
  await db.collection(COLLECTIONS.entitlements).add({
    data: {
      _openid: order._openid,
      orderId: order._id,
      outTradeNo,
      resultId: order.resultId,
      unlockResult: true,
      proAnalysisCredits: PRO_CREDITS_PER_PURCHASE,
      createdAt: new Date()
    }
  });
}

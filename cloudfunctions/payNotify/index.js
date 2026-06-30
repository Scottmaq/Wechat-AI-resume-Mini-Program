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
    console.log("payNotify event", event);
    const outTradeNo = String(event.outTradeNo || event.out_trade_no || "").trim();
    const transactionId = String(event.transactionId || event.transaction_id || "").trim();
    const totalFee = Number(event.totalFee || event.total_fee || event.amount || 0);
    const isSuccess = isPaySuccess(event);

    if (!outTradeNo) {
      return buildNotifyResult(false, "缺少商户订单号");
    }
    if (!isSuccess) {
      await markOrderFailed(outTradeNo, event);
      return buildNotifyResult(true, "非成功支付通知已记录");
    }

    const orderRes = await db.collection(COLLECTIONS.orders).where({ outTradeNo }).limit(1).get();
    const order = orderRes.data && orderRes.data[0] ? orderRes.data[0] : null;
    if (!order) return buildNotifyResult(false, "订单不存在");
    if (order.amountFen !== UNLOCK_PRICE_FEN) return buildNotifyResult(false, "订单金额异常");
    if (totalFee && totalFee !== order.amountFen) return buildNotifyResult(false, "支付通知金额不匹配");

    if (order.status !== "PAID") {
      await db.collection(COLLECTIONS.orders).doc(order._id).update({
        data: {
          status: "PAID",
          transactionId,
          rawNotify: event,
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

    return buildNotifyResult(true, "OK");
  } catch (error) {
    console.error("payNotify failed", error);
    return buildNotifyResult(false, error.message || "支付回调处理失败");
  }
};

function isPaySuccess(event) {
  const values = [
    event.returnCode,
    event.resultCode,
    event.tradeState,
    event.trade_state,
    event.status
  ].map((item) => String(item || "").toUpperCase());
  return values.includes("SUCCESS") || values.includes("PAID");
}

async function markOrderFailed(outTradeNo, event) {
  const res = await db.collection(COLLECTIONS.orders).where({ outTradeNo }).limit(1).get();
  const order = res.data && res.data[0] ? res.data[0] : null;
  if (!order || order.status === "PAID") return;
  await db.collection(COLLECTIONS.orders).doc(order._id).update({
    data: {
      status: "FAILED",
      rawNotify: event,
      updatedAt: new Date()
    }
  });
}

function buildNotifyResult(success, message) {
  return {
    errcode: success ? 0 : 1,
    errmsg: message
  };
}

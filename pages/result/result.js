const app = getApp();

Page({
  data: {
    record: null,
    result: null,
    shareText: "",
    resultId: "",
    loading: false,
    paying: false,
    deleting: false,
    downloading: false
  },

  onLoad(options) {
    let record = app.globalData.lastResult;
    if (options.id) {
      const history = wx.getStorageSync("resume_history") || [];
      record = history.find((item) => item.id === options.id) || record;
    }

    const resultId = (record && (record.resultId || record.id)) || options.resultId || "";
    this.setData({
      record: record || null,
      resultId
    });

    if (resultId) this.loadResult(resultId);
  },

  loadResult(resultId, options = {}) {
    if (!resultId || this.data.loading) return;

    if (!options.silent) {
      this.setData({ loading: true });
    }
    wx.cloud.callFunction({
      name: "getResult",
      data: { resultId }
    }).then((response) => {
      const res = response.result;
      if (!res || !res.ok) {
        throw new Error((res && res.message) || "获取结果失败");
      }
      const result = res.data;
      const record = {
        id: result.resultId,
        resultId: result.resultId,
        createdAt: result.createdAt || new Date().toISOString(),
        targetRole: result.targetRole,
        score: result.score,
        isUnlocked: !!result.isUnlocked,
        demoMode: !!result.demoMode
      };
      this.setData({
        record,
        result,
        shareText: `我刚用AI生成了一份${result.targetRole}简历评估，匹配评分 ${result.score} 分。`
      });
      app.globalData.lastResult = record;
      this.updateHistory(record);
    }).catch((error) => {
      wx.showModal({
        title: "结果加载失败",
        content: error.message || error.errMsg || "请稍后重试。",
        showCancel: false
      });
    }).finally(() => {
      if (!options.silent) {
        this.setData({ loading: false });
      }
    });
  },

  copyText(event) {
    if (!this.ensureUnlocked("支付后可复制完整简历。")) return;
    const text = event.currentTarget.dataset.text || "";
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: "已复制", icon: "success" });
      }
    });
  },

  downloadPdf() {
    if (!this.ensureUnlocked("支付后可下载PDF简历。")) return;
    const resultId = this.data.resultId;
    if (!resultId || this.data.downloading) return;

    this.setData({ downloading: true });
    this.downloadPdfFile(resultId).then((filePath) => {
      return this.openPdfDocument(filePath);
    }).catch((error) => {
      wx.showModal({
        title: "PDF下载失败",
        content: error.message || error.errMsg || "请稍后重试。",
        showCancel: false
      });
    }).finally(() => {
      this.setData({ downloading: false });
    });
  },

  async downloadPdfFile(resultId) {
    const directFileID = this.data.result && this.data.result.pdfFileID;
    if (directFileID) {
      try {
        const res = await this.downloadCloudFile(directFileID, 2);
        return res.tempFilePath;
      } catch (error) {
        console.warn("direct cloud download failed, fallback to temp url", error);
      }
    }

    const response = await wx.cloud.callFunction({
      name: "getPdfUrl",
      data: { resultId }
    });
    const result = response.result;
    if (!result || !result.ok) {
      throw new Error((result && result.message) || "获取PDF下载链接失败");
    }

    const res = await this.downloadUrlFile(result.tempFileURL, 2);
    if (res.statusCode && res.statusCode >= 400) {
      throw new Error(`PDF下载失败，状态码 ${res.statusCode}`);
    }
    return res.tempFilePath;
  },

  downloadCloudFile(fileID, retries) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: resolve,
        fail: reject
      });
    }).catch((error) => {
      if (retries <= 0) throw error;
      return this.wait(600).then(() => this.downloadCloudFile(fileID, retries - 1));
    });
  },

  downloadUrlFile(url, retries) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: resolve,
        fail: reject
      });
    }).catch((error) => {
      if (retries <= 0) throw error;
      return this.wait(600).then(() => this.downloadUrlFile(url, retries - 1));
    });
  },

  openPdfDocument(filePath) {
    return new Promise((resolve, reject) => {
      wx.openDocument({
        filePath,
        fileType: "pdf",
        showMenu: true,
        success: resolve,
        fail: reject
      });
    });
  },

  wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },

  unlockResult() {
    const resultId = this.data.resultId;
    if (!resultId || this.data.paying) return;
    if (this.data.result && this.data.result.isUnlocked) return;

    this.setData({ paying: true });
    wx.cloud.callFunction({
      name: "createOrder",
      data: { resultId }
    }).then((response) => {
      const res = response.result;
      if (!res || !res.ok) {
        throw new Error((res && res.message) || "创建订单失败");
      }
      if (res.alreadyUnlocked || res.mockPaid) {
        wx.showToast({ title: "已解锁", icon: "success" });
        this.refreshUntilUnlocked(resultId, 0);
        return null;
      }
      return this.requestPayment(res.payment);
    }).then((paid) => {
      if (paid === false || paid === null) return;
      wx.showToast({ title: "支付成功", icon: "success" });
      this.refreshUntilUnlocked(resultId, 0);
    }).catch((error) => {
      const message = error.errMsg && error.errMsg.indexOf("cancel") !== -1
        ? "支付已取消。"
        : (error.message || error.errMsg || "支付失败，请稍后再试。");
      wx.showToast({ title: message, icon: "none" });
      this.setData({ paying: false });
    }).finally(() => {
      if (this.data.paying && this.data.result && this.data.result.isUnlocked) {
        this.setData({ paying: false });
      }
    });
  },

  requestPayment(payment) {
    if (!payment) throw new Error("支付参数为空。");
    const params = payment.payment || payment;

    return new Promise((resolve, reject) => {
      wx.requestPayment({
        ...params,
        success: () => resolve(true),
        fail: reject
      });
    });
  },

  refreshUntilUnlocked(resultId, attempt) {
    wx.cloud.callFunction({
      name: "getResult",
      data: { resultId }
    }).then((response) => {
      const res = response.result;
      if (!res || !res.ok) throw new Error((res && res.message) || "获取结果失败");
      if (res.data && res.data.isUnlocked) {
        const record = {
          id: res.data.resultId,
          resultId: res.data.resultId,
          createdAt: res.data.createdAt || new Date().toISOString(),
          targetRole: res.data.targetRole,
          score: res.data.score,
          isUnlocked: true,
          demoMode: !!res.data.demoMode
        };
        this.setData({
          result: res.data,
          record,
          paying: false
        });
        app.globalData.lastResult = record;
        this.updateHistory(record);
        return;
      }
      if (attempt >= 5) {
        this.loadResult(resultId, { silent: true });
        return;
      }
      setTimeout(() => {
        this.refreshUntilUnlocked(resultId, attempt + 1);
      }, 1200);
    }).catch(() => {
      this.loadResult(resultId, { silent: true });
    });
  },

  deleteResult() {
    const resultId = this.data.resultId;
    if (!resultId || this.data.deleting) return;

    wx.showModal({
      title: "删除简历数据",
      content: "将删除云端生成结果、PDF文件和本地历史记录，删除后无法恢复。",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ deleting: true });
        wx.cloud.callFunction({
          name: "deleteResult",
          data: { resultId }
        }).then((response) => {
          const result = response.result;
          if (!result || !result.ok) {
            throw new Error((result && result.message) || "删除失败");
          }
          const history = wx.getStorageSync("resume_history") || [];
          wx.setStorageSync("resume_history", history.filter((item) => (item.resultId || item.id) !== resultId));
          app.globalData.lastResult = null;
          wx.showToast({ title: "已删除", icon: "success" });
          this.goHome();
        }).catch((error) => {
          wx.showToast({ title: error.message || "删除失败", icon: "none" });
        }).finally(() => {
          this.setData({ deleting: false });
        });
      }
    });
  },

  ensureUnlocked(message) {
    if (this.data.result && this.data.result.isUnlocked) return true;
    wx.showToast({ title: message, icon: "none" });
    return false;
  },

  updateHistory(record) {
    const history = wx.getStorageSync("resume_history") || [];
    const nextHistory = [record]
      .concat(history.filter((item) => (item.resultId || item.id) !== record.resultId))
      .slice(0, 20);
    wx.setStorageSync("resume_history", nextHistory);
  },

  goHome() {
    wx.switchTab({
      url: "/pages/index/index"
    });
  }
});

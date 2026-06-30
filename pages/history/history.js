const app = getApp();

Page({
  data: {
    history: []
  },

  onShow() {
    this.loadHistory();
  },

  loadHistory() {
    const history = (wx.getStorageSync("resume_history") || []).map((item) => ({
      ...item,
      resultId: item.resultId || item.id,
      score: item.score || (item.data && item.data.score) || "--",
      isUnlocked: !!item.isUnlocked,
      createdAtText: this.formatTime(item.createdAt)
    }));
    this.setData({ history });
  },

  formatTime(value) {
    const date = new Date(value);
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  openRecord(event) {
    const id = event.currentTarget.dataset.id;
    const record = this.data.history.find((item) => item.id === id);
    app.globalData.lastResult = record || null;
    wx.navigateTo({
      url: `/pages/result/result?id=${id}`
    });
  },

  clearHistory() {
    wx.showModal({
      title: "清空记录",
      content: "确定删除本机保存的所有优化记录？",
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync("resume_history");
        this.setData({ history: [] });
      }
    });
  },

  goHome() {
    wx.switchTab({
      url: "/pages/index/index"
    });
  }
});

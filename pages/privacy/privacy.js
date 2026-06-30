Page({
  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({
          url: "/pages/index/index"
        });
      }
    });
  }
});
